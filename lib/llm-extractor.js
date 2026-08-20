import { parseLlmJson } from './stage4-llm.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic-files.js'

const LEGACY_NOISE = new Set(['result', 'm', 'seq'])

function strings(values = []) {
  return [...new Set(values
    .flat()
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
}

function candidateEntities(candidate, index) {
  if (Array.isArray(candidate?.entities)) return candidate.entities
  return (candidate?.entityIds ?? []).map((id) => index.get(id, candidate?.scopeId ?? null)).filter(Boolean)
}

function responseEntities(parsed) {
  if (Array.isArray(parsed)) return parsed
  return Array.isArray(parsed?.entities) ? parsed.entities : []
}

export class LLMExtractor {
  constructor({ llm, index, config = {} }) {
    this.llm = llm
    this.index = index
    this.config = {
      batchSize: Math.max(1, config.refineBatchSize ?? config.batchSize ?? 5),
      minConfidence: config.minConfidence ?? 0.6,
      confirmedConfidence: config.confirmedConfidence ?? 0.9,
      cleanupLegacyOnStart: config.cleanupLegacyOnStart !== false,
      cleanupMigrationVersion: 1,
    }
    this.stats = {
      queued: 0,
      refined: 0,
      ruleFallbacks: 0,
      failed: 0,
      removedNoise: 0,
      mergedAliases: 0,
      totalDurationMs: 0,
      cleanup: null,
      lastError: null,
    }
    this.pendingQueue = []
    this.worker = null
  }

  isGenericNoise(entity) {
    const name = String(entity?.name ?? '').trim()
    if (!name) return true
    if (LEGACY_NOISE.has(name.toLowerCase())) return true
    if (entity?.entityType !== 'generic' || !/^[A-Za-z][\w-]*$/.test(name)) return false
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const assignmentKey = (entity.observations ?? [])
      .some((observation) => new RegExp(`^\\s*${escaped}\\s*=`,'i').test(observation))
    return !assignmentKey
  }

  consolidateExisting() {
    const scopeId = 'global'
    const before = this.index.count(scopeId)
    const dropIds = []
    let aliasMerges = 0
    for (const entity of this.index.all(scopeId)) {
      if (/^color-\d+$/i.test(entity.name) && (entity.observations ?? []).length > 0) {
        const ownerName = entity.observations.join(' ').match(/客户#\d+/)?.[0]
        const owner = ownerName ? this.index.getEntityByName(ownerName, scopeId) : null
        if (owner && owner.id !== entity.id) {
          this.index.mergeEntities(owner.id, [entity.id], {
            aliases: [entity.name],
            confidence: Math.max(owner.confidence ?? 0.6, entity.confidence ?? 0.6),
          })
          aliasMerges += 1
          continue
        }
      }
      if (this.isGenericNoise(entity)) dropIds.push(entity.id)
    }
    const removed = this.index.removeEntities(dropIds, scopeId)
    if (removed > 0 || aliasMerges > 0) this.index.flush()
    const result = {
      before,
      after: this.index.count(scopeId),
      removed,
      aliasMerges,
      reductionRate: before === 0 ? 0 : (before - this.index.count(scopeId)) / before,
    }
    this.stats.removedNoise += removed
    this.stats.mergedAliases += aliasMerges
    this.stats.cleanup = result
    return result
  }

  migrateLegacyOnce() {
    const version = this.config.cleanupMigrationVersion
    const marker = join(this.index.indexDir, `legacy-cleanup-v${version}.json`)
    if (existsSync(marker)) {
      const result = { skipped: true, reason: 'already-migrated', version, marker }
      this.stats.cleanup = result
      return result
    }
    const backupDir = join(this.index.indexDir, `legacy-backup-v${version}`)
    const backup = this.index.backupLegacy(backupDir)
    const cleanup = this.consolidateExisting()
    const result = { ...cleanup, skipped: false, version, marker, backupDir, backup }
    atomicWriteJson(marker, { ...result, migratedAt: Date.now() })
    this.stats.cleanup = result
    return result
  }

  #ruleFallback(candidate, entities, error = null) {
    for (const entity of entities) {
      if (entity?.id) this.index.setEntityConfidence(entity.id, this.config.minConfidence)
    }
    this.stats.ruleFallbacks += 1
    if (error) {
      this.stats.failed += 1
      this.stats.lastError = String(error)
    }
    return {
      refined: false,
      fallback: 'rule',
      entities: entities.map((entity) => ({ ...entity, confidence: this.config.minConfidence })),
      error: error ? String(error) : null,
      sourceRef: candidate?.sourceRef ?? null,
    }
  }

  async refine(candidate) {
    const started = performance.now()
    const entities = candidateEntities(candidate, this.index)
    const scopeId = String(candidate?.scopeId ?? entities[0]?.scopeId ?? 'global')
    for (const entity of entities) {
      if (entity?.id) this.index.setEntityConfidence(entity.id, this.config.minConfidence)
    }
    if (!this.llm || entities.length === 0) {
      this.stats.totalDurationMs += performance.now() - started
      return this.#ruleFallback(candidate, entities)
    }

    const compact = {
      text: String(candidate?.text ?? '').slice(0, 1600),
      entities: entities.map((entity) => ({
        name: entity.name,
        type: entity.entityType,
        observations: (entity.observations ?? []).slice(0, 4),
      })),
    }
    const prompt = `复核记忆抽取并只返回JSON：{"entities":[{"name":"规范名","type":"类型","aliases":[],"observations":[],"mergeFrom":[],"genericNoise":false}]}。删除RESULT/m/seq等噪声，值实体并入事实主体。输入：${JSON.stringify(compact)}`
    try {
      const parsed = parseLlmJson(await this.llm.complete(prompt, {
        system: '你是感知记忆精抽器。只输出紧凑JSON，不解释。',
        maxTokens: 768,
        purpose: 'sensory-refine',
        sessionId: candidate?.sourceRef?.sessionId,
      }))
      const refined = responseEntities(parsed)
      if (refined.length === 0 && Array.isArray(parsed?.entities)) {
        const removed = this.index.removeEntities(entities.map((entity) => entity.id).filter(Boolean), scopeId)
        this.stats.removedNoise += removed
        this.stats.refined += 1
        this.index.flush()
        return { refined: true, rejectedAll: true, fallback: null, entities: [], conflicts: parsed?.conflicts ?? [] }
      }
      if (refined.length === 0) throw new Error('refiner returned no entities')

      const byName = new Map(entities.map((entity) => [String(entity.name).toLowerCase(), entity]))
      const explicitNoise = new Set(strings([
        parsed?.noise,
        refined.filter((entry) => entry?.genericNoise || entry?.action === 'drop').map((entry) => entry.name),
      ]).map((name) => name.toLowerCase()))
      for (const entity of entities) {
        if (LEGACY_NOISE.has(String(entity.name).toLowerCase())) explicitNoise.add(String(entity.name).toLowerCase())
      }

      const removedIds = []
      for (const name of explicitNoise) {
        const entity = byName.get(name) ?? this.index.getEntityByName(name, scopeId)
        if (entity?.id) removedIds.push(entity.id)
      }
      this.stats.removedNoise += this.index.removeEntities(removedIds, scopeId)

      const applied = []
      for (const entry of refined) {
        if (!entry?.name || entry.genericNoise || entry.action === 'drop') continue
        const aliases = strings([entry.aliases, entry.alias])
        const mergeNames = strings([entry.mergeFrom, aliases, entry.name])
        const mergeIds = mergeNames
          .map((name) => byName.get(String(name).toLowerCase()) ?? this.index.getEntityByName(name, scopeId))
          .filter(Boolean)
          .map((entity) => entity.id)
        let target = this.index.getEntityByName(entry.name, scopeId)
          ?? aliases.map((alias) => this.index.getEntityByName(alias, scopeId)).find(Boolean)
          ?? mergeIds.map((id) => this.index.get(id, scopeId)).find(Boolean)

        if (this.index.writeModeFor?.(scopeId) === 'propose' || this.index.writeMode === 'propose') {
          const proposal = target
            ? this.index.updateEntity(target.id, { aliases, observations: entry.observations, confidence: this.config.confirmedConfidence })
            : this.index.addEntity({ name: entry.name, entityType: entry.type, aliases, observations: entry.observations, confidence: this.config.confirmedConfidence, scopeId })
          applied.push({ name: entry.name, proposed: true, proposal })
          continue
        }

        if (!target) {
          const id = this.index.addEntity({
            name: entry.name,
            entityType: entry.type,
            aliases,
            observations: entry.observations,
            confidence: this.config.confirmedConfidence,
            confirmed: true,
            scopeId,
          })
          target = this.index.get(id, scopeId)
        } else {
          this.index.updateEntity(target.id, {
            name: entry.name,
            entityType: entry.type,
            aliases,
            observations: entry.observations,
            confidence: this.config.confirmedConfidence,
            confirmed: true,
          })
        }
        const sources = [...new Set(mergeIds)].filter((id) => id !== target.id && this.index.get(id, scopeId))
        if (sources.length > 0) {
          this.index.mergeEntities(target.id, sources, {
            aliases: mergeNames.filter((name) => String(name).toLowerCase() !== String(entry.name).toLowerCase()),
            confidence: this.config.confirmedConfidence,
          })
          this.stats.mergedAliases += sources.length
        }
        this.index.setEntityConfidence(target.id, this.config.confirmedConfidence)
        applied.push(this.index.get(target.id, scopeId))
      }
      this.index.flush()
      this.stats.refined += 1
      return { refined: true, fallback: null, entities: applied, conflicts: parsed?.conflicts ?? [] }
    } catch (error) {
      return this.#ruleFallback(candidate, entities, error)
    } finally {
      this.stats.totalDurationMs += performance.now() - started
    }
  }

  async settle(queue = []) {
    const pending = Array.isArray(queue) ? queue.filter(Boolean) : []
    this.stats.queued += pending.length
    this.pendingQueue.push(...pending)
    if (!this.worker) {
      this.worker = this.#drain().finally(() => { this.worker = null })
    }
    return this.worker
  }

  async #drain() {
    const results = []
    while (this.pendingQueue.length > 0) {
      const first = this.pendingQueue.shift()
      const scopeId = String(first?.scopeId ?? 'global')
      const batch = [first]
      for (let index = 0; index < this.pendingQueue.length && batch.length < this.config.batchSize;) {
        if (String(this.pendingQueue[index]?.scopeId ?? 'global') === scopeId) batch.push(...this.pendingQueue.splice(index, 1))
        else index += 1
      }
      const combined = {
        text: batch.map((candidate) => candidate.text).filter(Boolean).join('\n---\n'),
        entityIds: [...new Set(batch.flatMap((candidate) => candidate.entityIds ?? candidate.entities?.map((entity) => entity.id) ?? []))],
        sourceRef: batch.at(-1)?.sourceRef,
        scopeId,
      }
      results.push(await this.refine(combined))
    }
    return results
  }

  async drain(sessionId = null) {
    while (this.worker || this.pendingQueue.some((item) => sessionId === null || String(item.scopeId) === String(sessionId))) {
      if (!this.worker && this.pendingQueue.length > 0) this.worker = this.#drain().finally(() => { this.worker = null })
      if (this.worker) await this.worker
      else break
    }
    return { sessionId, pending: this.pendingQueue.length, active: Boolean(this.worker) }
  }

  status() {
    return { ...this.stats, pending: this.pendingQueue.length, active: Boolean(this.worker), config: { ...this.config } }
  }
}

export const LEGACY_NOISE_NAMES = [...LEGACY_NOISE]
