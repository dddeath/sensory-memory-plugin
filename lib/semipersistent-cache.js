import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { atomicWriteJson } from './atomic-files.js'

const CACHE_VERSION = 5

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function estimateTokens(text) {
  let total = 0
  let ascii = 0
  for (const character of String(text ?? '')) {
    if (/[^\x00-\x7F]/u.test(character)) {
      if (ascii) total += Math.ceil(ascii / 4)
      ascii = 0
      total += 1
    } else ascii += 1
  }
  return total + Math.ceil(ascii / 4)
}

function scopeOf(value) {
  return String(value ?? 'global') || 'global'
}

function entryKey(scopeId, entityId) {
  return `${scopeOf(scopeId)}\u0000${entityId}`
}

export class SemipersistentCache {
  constructor({ index, config = {} }) {
    this.index = index
    this.config = {
      promoteAfter: Math.max(1, config.promoteAfter ?? 3),
      cacheMaxEntries: Math.max(1, config.cacheMaxEntries ?? 20),
      cacheBudgetTokens: Math.max(1, config.cacheBudgetTokens ?? 100),
      demoteAfterDays: config.demoteAfterDays ?? 7,
      minConfidence: Math.max(0, Math.min(1, config.cacheMinConfidence ?? 0.6)),
      filter: typeof config.cacheFilter === 'function' ? config.cacheFilter : null,
    }
    this.path = config.cachePath ?? join(index.indexDir, 'cache.json')
    this.entries = new Map()
    this.hitCounts = new Map()
    this.lastEvicted = null
    this.seenHits = new Map()
    this.#load()
  }

  #load() {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (![4, CACHE_VERSION].includes(parsed?.version)) return
      for (const raw of parsed?.entries ?? []) {
        const scopeId = scopeOf(raw.scopeId)
        const entity = raw?.entityId ? this.index.get(raw.entityId, scopeId) : null
        if (!entity || !this.#eligible(entity)) continue
        const entry = { ...raw, scopeId }
        this.entries.set(entryKey(scopeId, entry.entityId), entry)
      }
      for (const [rawKey, count] of Object.entries(parsed?.hitCounts ?? {})) {
        if (!Number.isFinite(count)) continue
        const key = rawKey.includes('\u0000') ? rawKey : entryKey('global', rawKey)
        this.hitCounts.set(key, count)
      }
    } catch {
      this.entries.clear()
      this.hitCounts.clear()
    }
  }

  #save() {
    atomicWriteJson(this.path, {
      version: CACHE_VERSION,
      entries: [...this.entries.values()],
      hitCounts: Object.fromEntries(this.hitCounts),
    })
  }

  #eligible(entity) {
    if (!entity || entity.type !== 'entity') return false
    if (!(entity.observations ?? []).some((value) => String(value).trim())) return false
    if ((entity.confidence ?? 0) < this.config.minConfidence) return false
    return this.config.filter ? Boolean(this.config.filter(entity)) : true
  }

  #enforceLru(scopeId) {
    const scopeEntries = () => [...this.entries.values()].filter((entry) => entry.scopeId === scopeId)
    while (scopeEntries().length > this.config.cacheMaxEntries) {
      const oldest = scopeEntries().sort((left, right) => left.lastHitAt - right.lastHitAt || left.promotedAt - right.promotedAt)[0]
      this.entries.delete(entryKey(scopeId, oldest.entityId))
      this.lastEvicted = { ...oldest, evictedAt: Date.now(), reason: 'lru' }
    }
  }

  onHit(entityId, viewer = {}) {
    const scopeId = scopeOf(viewer.scopeId ?? this.index.scopeOf(entityId))
    const key = entryKey(scopeId, entityId)
    const touched = this.index.touch?.(entityId, scopeId) ?? this.index.get(entityId, scopeId)
    if (!touched || touched.type !== 'entity') return null
    if (!this.#eligible(touched)) return { entityId, scopeId, hitCount: 0, cached: false, eligible: false }
    const turnKey = viewer?.turnKey ? `${key}:${viewer.turnKey}` : null
    if (turnKey && this.seenHits.has(turnKey)) {
      return { entityId, scopeId, hitCount: this.hitCounts.get(key) ?? 0, cached: this.entries.has(key), deduplicated: true }
    }
    if (turnKey) {
      this.seenHits.set(turnKey, Date.now())
      while (this.seenHits.size > 500) this.seenHits.delete(this.seenHits.keys().next().value)
    }
    const hitCount = (this.hitCounts.get(key) ?? 0) + 1
    this.hitCounts.set(key, hitCount)
    let entry = this.entries.get(key)
    if (hitCount >= this.config.promoteAfter) {
      entry = { entityId, scopeId, hitCount, promotedAt: entry?.promotedAt ?? Date.now(), lastHitAt: Date.now() }
      this.entries.delete(key)
      this.entries.set(key, entry)
      this.#enforceLru(scopeId)
    }
    this.#save()
    return { entityId, scopeId, hitCount, cached: this.entries.has(key), entry: clone(entry) }
  }

  renderPriority(hits, viewer = {}) {
    const allowed = Array.isArray(hits) ? new Set(hits.map((hit) => hit.id).filter(Boolean)) : null
    const inferredScope = Array.isArray(hits) && hits.length > 0 ? hits[0].scopeId : null
    const scopeId = scopeOf(viewer.scopeId ?? inferredScope ?? 'global')
    const ordered = [...this.entries.values()]
      .filter((entry) => entry.scopeId === scopeId && (!allowed || allowed.has(entry.entityId)))
      .sort((left, right) => right.lastHitAt - left.lastHitAt)
    const rendered = []
    let tokens = 0
    for (const entry of ordered) {
      const entity = this.index.get(entry.entityId, scopeId)
      if (!entity) continue
      const summary = entity.observations?.[0] ?? ''
      const cost = estimateTokens(`- [cache] [[${entity.name}]] ${summary}`)
      if (tokens + cost > this.config.cacheBudgetTokens) break
      tokens += cost
      rendered.push({
        id: entity.id,
        name: entity.name,
        summary,
        content: (entity.observations ?? []).join('\n'),
        source_refs: entity.source_refs ?? [],
        scopeId,
        cache: true,
        cacheHitCount: entry.hitCount,
      })
    }
    return rendered
  }

  dropScope(scopeId) {
    const scope = scopeOf(scopeId)
    let removed = 0
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${scope}\u0000`)) { this.entries.delete(key); removed += 1 }
    for (const key of [...this.hitCounts.keys()]) if (key.startsWith(`${scope}\u0000`)) this.hitCounts.delete(key)
    for (const key of [...this.seenHits.keys()]) if (key.includes(`${scope}\u0000`)) this.seenHits.delete(key)
    this.#save()
    return { scopeId: scope, removed }
  }

  status(scopeId = null) {
    const entries = [...this.entries.values()].filter((entry) => scopeId === null || entry.scopeId === scopeOf(scopeId))
    return {
      scopeId: scopeId === null ? null : scopeOf(scopeId),
      entryCount: entries.length,
      maxEntries: this.config.cacheMaxEntries,
      promoteAfter: this.config.promoteAfter,
      budgetTokens: this.config.cacheBudgetTokens,
      minConfidence: this.config.minConfidence,
      entries: entries.map((entry) => ({ ...entry, entity: this.index.get(entry.entityId, entry.scopeId)?.name ?? null })),
      lastEvicted: clone(this.lastEvicted),
      path: this.path,
      version: CACHE_VERSION,
    }
  }
}

export const SEMIPERSISTENT_CACHE_VERSION = CACHE_VERSION
