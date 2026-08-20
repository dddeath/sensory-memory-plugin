import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import { appendAndFsync, atomicWriteFile, atomicWriteJson } from './atomic-files.js'
import { NgramHashAddressing } from './hash.js'

const STORAGE_VERSION = 1
const MIGRATION_VERSION = 1
const JSONL_FILES = Object.freeze({
  entities: 'entities.jsonl',
  relations: 'relations.jsonl',
  observations: 'observations.jsonl',
})

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function uniqueStrings(values = []) {
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
}

function normalizeScope(value) {
  const scope = String(value ?? 'global').trim()
  return scope || 'global'
}

function recordScope(record) {
  return normalizeScope(record?.scopeId)
}

function withScope(record, scopeId) {
  const normalized = normalizeScope(scopeId)
  if (normalized === 'global') {
    const { scopeId: _ignored, ...legacyCompatible } = record
    return legacyCompatible
  }
  return { ...record, scopeId: normalized }
}

function uniqueSourceRefs(values = []) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    if (value.sessionId === undefined || value.seq === undefined) continue
    const normalized = { sessionId: String(value.sessionId), seq: value.seq }
    const key = `${normalized.sessionId}\u0000${String(normalized.seq)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function normalizeTitle(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function scopedTitle(scopeId, title) {
  return `${normalizeScope(scopeId)}\u0000${normalizeTitle(title)}`
}

function bagTokens(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const match of normalized.matchAll(/[a-z][\w-]*|\d+/g)) tokens.add(match[0])
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let width = 2; width <= 4; width += 1) {
      for (let index = 0; index + width <= run.length; index += 1) tokens.add(run.slice(index, index + width))
    }
  }
  const compact = normalizeTitle(normalized)
  if (compact) tokens.add(compact)
  return [...tokens]
}

function jsonl(records) {
  return records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const records = []
  for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error.message}`)
    }
  }
  return records
}

function safeSegment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' || /^\.+$/.test(cleaned) ? '_' : cleaned
}

function sourceRefKey(value) {
  if (!value || value.sessionId === undefined || value.seq === undefined) return null
  return `${String(value.sessionId)}\u0000${String(value.seq)}`
}

function countFiles(path) {
  if (!existsSync(path)) return 0
  let count = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(path, entry.name)) : 1
  }
  return count
}

export class SensoryIndex {
  constructor(indexDir, config = {}) {
    if (typeof indexDir !== 'string' || indexDir.trim() === '') throw new TypeError('indexDir must be a non-empty string')
    this.indexDir = resolve(indexDir)
    this.config = {
      journalCompactAfter: Math.max(10, config.journalCompactAfter ?? 2000),
      legacyMirror: config.legacyMirror !== false,
    }
    this.hasher = new NgramHashAddressing()
    this.entities = new Map()
    this.relations = new Map()
    this.observations = new Map()
    this.aliases = new Map()
    this.titleIndex = new Map()
    this.scopeTitleIndex = new Map()
    this.tokenIndex = new Map()
    this.hashIndex = new Map()
    this.lastTimestamp = 0
    this.writeMode = 'direct'
    this.writeModes = new Map()
    this.proposals = []
    this.sequence = 0
    this.journalRecordCount = 0
    this.dirtyMutations = []
    this.recovery = null
    this.journalPath = join(this.indexDir, 'mutations.jsonl')
    this.metaPath = join(this.indexDir, 'storage-meta.json')

    mkdirSync(this.indexDir, { recursive: true })
    mkdirSync(join(this.indexDir, 'source'), { recursive: true })
    for (const file of Object.values(JSONL_FILES)) {
      const path = join(this.indexDir, file)
      if (!existsSync(path)) atomicWriteFile(path, '')
    }
    if (!existsSync(this.journalPath)) atomicWriteFile(this.journalPath, '')
    if (!existsSync(join(this.indexDir, 'rounds.json'))) atomicWriteFile(join(this.indexDir, 'rounds.json'), '{"tracked":[]}\n')
    if (!existsSync(join(this.indexDir, 'aliases.json'))) atomicWriteFile(join(this.indexDir, 'aliases.json'), '{}\n')
    this.#load()
  }

  #load() {
    for (const entity of readJsonl(join(this.indexDir, JSONL_FILES.entities))) this.entities.set(entity.id, entity)
    for (const relation of readJsonl(join(this.indexDir, JSONL_FILES.relations))) this.relations.set(relation.id, relation)
    for (const observation of readJsonl(join(this.indexDir, JSONL_FILES.observations))) this.observations.set(observation.id, observation)
    const aliasesPath = join(this.indexDir, 'aliases.json')
    if (existsSync(aliasesPath)) {
      const parsed = JSON.parse(readFileSync(aliasesPath, 'utf8'))
      for (const [id, aliases] of Object.entries(parsed ?? {})) this.aliases.set(id, uniqueStrings(aliases))
    }
    this.#replayJournal()
    for (const record of [...this.entities.values(), ...this.relations.values(), ...this.observations.values()]) {
      this.lastTimestamp = Math.max(this.lastTimestamp, record.valid_from ?? 0, record.valid_to ?? 0, record.last_hit_at ?? 0)
    }
    this.#rebuildIndexes()
  }

  #replayJournal() {
    if (!existsSync(this.journalPath)) return
    const text = readFileSync(this.journalPath, 'utf8')
    const lines = text.split(/\r?\n/)
    let lastNonEmpty = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].trim()) { lastNonEmpty = index; break }
    }
    const valid = []
    for (let index = 0; index <= lastNonEmpty; index += 1) {
      const line = lines[index]
      if (!line.trim()) continue
      try {
        const mutation = JSON.parse(line)
        this.#applyMutation(mutation)
        this.sequence = Math.max(this.sequence, Number(mutation.sequence) || 0)
        this.journalRecordCount += 1
        valid.push(line)
      } catch (error) {
        if (index !== lastNonEmpty) throw new Error(`Invalid mutation journal at ${this.journalPath}:${index + 1}: ${error.message}`)
        this.recovery = { type: 'truncated-tail', line: index + 1, error: String(error) }
        atomicWriteFile(this.journalPath, valid.length ? `${valid.join('\n')}\n` : '')
      }
    }
  }

  #applyMutation(mutation) {
    if (mutation?.version !== STORAGE_VERSION) throw new Error(`Unsupported mutation version: ${mutation?.version}`)
    const collection = mutation.collection
    const map = collection === 'aliases' ? this.aliases : this[collection]
    if (!(map instanceof Map)) throw new Error(`Unknown mutation collection: ${collection}`)
    if (mutation.op === 'delete') map.delete(mutation.id)
    else if (mutation.op === 'upsert') map.set(mutation.id, clone(mutation.value))
    else throw new Error(`Unknown mutation operation: ${mutation.op}`)
  }

  #record(collection, op, id, value, scopeId = 'global') {
    this.sequence += 1
    this.dirtyMutations.push({
      version: STORAGE_VERSION,
      sequence: this.sequence,
      scopeId: normalizeScope(scopeId),
      collection,
      op,
      id,
      ...(op === 'upsert' ? { value: clone(value) } : {}),
    })
  }

  #entityView(entity) {
    if (!entity) return null
    const aliases = this.aliases.get(entity.id) ?? []
    return clone({ ...entity, ...(aliases.length > 0 ? { aliases } : {}) })
  }

  #now() {
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    this.lastTimestamp = timestamp
    return timestamp
  }

  #rebuildIndexes() {
    this.titleIndex.clear()
    this.scopeTitleIndex.clear()
    this.tokenIndex.clear()
    this.hashIndex.clear()
    for (const entity of this.entities.values()) {
      const scopeId = recordScope(entity)
      const aliases = this.aliases.get(entity.id) ?? []
      for (const value of [entity.name, ...aliases]) {
        const title = normalizeTitle(value)
        if (!title) continue
        this.scopeTitleIndex.set(scopedTitle(scopeId, title), entity.id)
        if (scopeId === 'global') this.titleIndex.set(title, entity.id)
      }
      const material = [entity.name, ...aliases, ...(entity.observations ?? []), ...(entity.keywords ?? [])].join(' ')
      for (const token of bagTokens(material)) this.#indexSet(this.tokenIndex, token, entity.id)
      for (const slot of this.hasher.slotKeys(this.hasher.hash(material))) this.#indexSet(this.hashIndex, slot, entity.id)
    }
  }

  #indexSet(index, key, id) {
    let ids = index.get(key)
    if (!ids) index.set(key, ids = new Set())
    ids.add(id)
  }

  #scopeFrom(value = {}) {
    return normalizeScope(value.scopeId ?? value.sourceRef?.scopeId)
  }

  #createObservation(entityId, contents, sourceRef, confidence, scopeId) {
    const record = withScope({
      type: 'observation',
      id: `o_${randomUUID()}`,
      entity: entityId,
      contents: uniqueStrings(Array.isArray(contents) ? contents : [contents]),
      valid_from: this.#now(),
      valid_to: null,
      confidence: Number.isFinite(confidence) ? confidence : 0.6,
      source_refs: uniqueSourceRefs(sourceRef ? [sourceRef] : []),
    }, scopeId)
    this.observations.set(record.id, record)
    this.#record('observations', 'upsert', record.id, record, scopeId)
    return record
  }

  scopeOf(recordOrId) {
    const record = typeof recordOrId === 'string'
      ? this.entities.get(recordOrId) ?? this.relations.get(recordOrId) ?? this.observations.get(recordOrId)
      : recordOrId
    return recordScope(record)
  }

  inScope(recordOrId, scopeId = 'global') {
    return this.scopeOf(recordOrId) === normalizeScope(scopeId)
  }

  addEntity(options = {}) {
    const { name, entityType, observations = [], sourceRef, keywords = [], aliases = [], confidence = 0.6, confirmed = false } = options
    const scopeId = this.#scopeFrom(options)
    const normalizedName = String(name ?? '').trim()
    if (!normalizedName) throw new TypeError('entity name must be non-empty')
    if (this.writeModeFor(scopeId) === 'propose' && !confirmed) {
      const proposal = { id: `proposal_${randomUUID()}`, operation: 'addEntity', createdAt: this.#now(), scopeId, value: clone(options) }
      this.proposals.push(proposal)
      return proposal.id
    }
    const existing = this.scopeTitleIndex.get(scopedTitle(scopeId, normalizedName))
    if (existing) {
      this.updateEntity(existing, { entityType, observations, sourceRef, keywords, aliases, confidence, confirmed, scopeId })
      return existing
    }
    const normalizedObservations = uniqueStrings(observations)
    const record = withScope({
      type: 'entity', id: `e_${randomUUID()}`, name: normalizedName,
      entityType: String(entityType || 'generic'), observations: normalizedObservations,
      valid_from: this.#now(), valid_to: null,
      confidence: Number.isFinite(confidence) ? confidence : 0.6,
      source_refs: uniqueSourceRefs(sourceRef ? [sourceRef] : []), keywords: uniqueStrings(keywords),
      demote_at: null, hit_count: 0, last_hit_at: null,
    }, scopeId)
    this.entities.set(record.id, record)
    this.#record('entities', 'upsert', record.id, record, scopeId)
    const normalizedAliases = uniqueStrings(aliases)
    if (normalizedAliases.length > 0) {
      this.aliases.set(record.id, normalizedAliases)
      this.#record('aliases', 'upsert', record.id, normalizedAliases, scopeId)
    }
    for (const content of normalizedObservations) this.#createObservation(record.id, content, sourceRef, record.confidence, scopeId)
    this.#rebuildIndexes()
    return record.id
  }

  updateEntity(id, patch = {}) {
    const entity = this.entities.get(id)
    if (!entity) throw new Error(`Unknown entity: ${id}`)
    const scopeId = recordScope(entity)
    if (patch.scopeId !== undefined && normalizeScope(patch.scopeId) !== scopeId) throw new Error('entity scope is immutable')
    if (this.writeModeFor(scopeId) === 'propose' && patch.confirmed !== true) {
      const proposal = { id: `proposal_${randomUUID()}`, operation: 'updateEntity', createdAt: this.#now(), scopeId, entityId: id, value: clone(patch) }
      this.proposals.push(proposal)
      return clone(proposal)
    }
    const addedObservations = uniqueStrings(patch.observations ?? [])
    entity.observations = uniqueStrings([...(entity.observations ?? []), ...addedObservations])
    entity.keywords = uniqueStrings([...(entity.keywords ?? []), ...(patch.keywords ?? [])])
    const aliases = uniqueStrings([...(this.aliases.get(id) ?? []), ...(patch.aliases ?? [])])
    if (aliases.length > 0) {
      this.aliases.set(id, aliases)
      this.#record('aliases', 'upsert', id, aliases, scopeId)
    }
    entity.source_refs = uniqueSourceRefs([...(entity.source_refs ?? []), ...(patch.source_refs ?? []), ...(patch.sourceRef ? [patch.sourceRef] : [])])
    if (typeof patch.name === 'string' && patch.name.trim()) entity.name = patch.name.trim()
    if (typeof patch.entityType === 'string' && patch.entityType.trim()) entity.entityType = patch.entityType.trim()
    if (Number.isFinite(patch.confidence) && patch.confidence > entity.confidence) entity.confidence = patch.confidence
    for (const content of addedObservations) this.#createObservation(entity.id, content, patch.sourceRef, patch.confidence ?? entity.confidence, scopeId)
    this.#record('entities', 'upsert', id, entity, scopeId)
    this.#rebuildIndexes()
    return this.#entityView(entity)
  }

  setEntityConfidence(id, confidence) {
    const entity = this.entities.get(id)
    if (!entity || !Number.isFinite(confidence)) return null
    entity.confidence = Math.max(0, Math.min(1, confidence))
    this.#record('entities', 'upsert', id, entity, recordScope(entity))
    return this.#entityView(entity)
  }

  removeEntity(id) { return this.removeEntities([id]) > 0 }

  removeEntities(ids = [], scopeId = null) {
    const normalizedScope = scopeId === null ? null : normalizeScope(scopeId)
    const removing = new Set(ids.filter((id) => this.entities.has(id) && (normalizedScope === null || this.inScope(id, normalizedScope))))
    if (removing.size === 0) return 0
    for (const id of removing) {
      const scope = recordScope(this.entities.get(id))
      this.entities.delete(id)
      this.aliases.delete(id)
      this.#record('entities', 'delete', id, null, scope)
      this.#record('aliases', 'delete', id, null, scope)
    }
    for (const [id, observation] of this.observations) if (removing.has(observation.entity)) {
      this.observations.delete(id)
      this.#record('observations', 'delete', id, null, recordScope(observation))
    }
    for (const [id, relation] of this.relations) if (removing.has(relation.from) || removing.has(relation.to)) {
      this.relations.delete(id)
      this.#record('relations', 'delete', id, null, recordScope(relation))
    }
    this.#rebuildIndexes()
    return removing.size
  }

  mergeEntities(targetId, sourceIds = [], patch = {}) {
    const target = this.entities.get(targetId)
    if (!target) throw new Error(`Unknown merge target: ${targetId}`)
    const scopeId = recordScope(target)
    const sources = sourceIds.filter((id) => id !== targetId).map((id) => this.entities.get(id)).filter((entity) => entity && recordScope(entity) === scopeId)
    this.updateEntity(targetId, {
      observations: [...sources.flatMap((entity) => entity.observations ?? []), ...(patch.observations ?? [])],
      keywords: [...sources.flatMap((entity) => entity.keywords ?? []), ...(patch.keywords ?? [])],
      aliases: [...sources.flatMap((entity) => [entity.name, ...(this.aliases.get(entity.id) ?? [])]), ...(patch.aliases ?? [])],
      source_refs: [...sources.flatMap((entity) => entity.source_refs ?? []), ...(patch.source_refs ?? [])],
      entityType: patch.entityType, confidence: patch.confidence, confirmed: true,
    })
    for (const source of sources) this.removeEntity(source.id)
    return this.#entityView(this.entities.get(targetId))
  }

  writeModeFor(scopeId = 'global') {
    return this.writeModes.get(normalizeScope(scopeId))?.mode ?? this.writeMode
  }

  setWriteMode(mode, reason = null, scopeId = 'global') {
    if (!['direct', 'propose'].includes(mode)) throw new TypeError(`Unknown write mode: ${mode}`)
    const scope = normalizeScope(scopeId)
    this.writeModes.set(scope, { mode, reason })
    if (scope === 'global') {
      this.writeMode = mode
      this.writeModeReason = reason
    }
    return { mode, reason, scopeId: scope, proposalCount: this.proposals.filter((item) => normalizeScope(item.scopeId) === scope).length }
  }

  proposalStatus(scopeId = 'global') {
    const scope = normalizeScope(scopeId)
    const state = this.writeModes.get(scope)
    const proposals = this.proposals.filter((item) => normalizeScope(item.scopeId) === scope)
    return { mode: state?.mode ?? this.writeMode, reason: state?.reason ?? null, scopeId: scope, count: proposals.length, proposals: clone(proposals) }
  }

  addRelation(options = {}) {
    const { from, to, relationType, sourceRef, confidence = 0.6, confirmed = false } = options
    const scopeId = this.#scopeFrom(options)
    if (this.writeModeFor(scopeId) === 'propose' && !confirmed) {
      const proposal = { id: `proposal_${randomUUID()}`, operation: 'addRelation', createdAt: this.#now(), scopeId, value: clone(options) }
      this.proposals.push(proposal)
      return proposal.id
    }
    if (!this.entities.has(from) || !this.entities.has(to)) throw new Error('relation endpoints must reference existing entities')
    if (!this.inScope(from, scopeId) || !this.inScope(to, scopeId)) throw new Error('relation endpoints must share the relation scope')
    const record = withScope({
      type: 'relation', id: `r_${randomUUID()}`, from, to,
      relationType: String(relationType || 'related_to'), valid_from: this.#now(), valid_to: null,
      confidence: Number.isFinite(confidence) ? confidence : 0.6,
      source_refs: uniqueSourceRefs(sourceRef ? [sourceRef] : []),
    }, scopeId)
    this.relations.set(record.id, record)
    this.#record('relations', 'upsert', record.id, record, scopeId)
    return record.id
  }

  addObservation(options = {}) {
    const { entityId, content, sourceRef, confidence = 0.6, confirmed = false } = options
    const entity = this.entities.get(entityId)
    if (!entity) throw new Error(`Unknown entity: ${entityId}`)
    const scopeId = recordScope(entity)
    if (this.writeModeFor(scopeId) === 'propose' && !confirmed) {
      const proposal = { id: `proposal_${randomUUID()}`, operation: 'addObservation', createdAt: this.#now(), scopeId, value: clone(options) }
      this.proposals.push(proposal)
      return proposal.id
    }
    const contents = uniqueStrings(Array.isArray(content) ? content : [content])
    if (contents.length === 0) throw new TypeError('observation content must be non-empty')
    entity.observations = uniqueStrings([...(entity.observations ?? []), ...contents])
    entity.source_refs = uniqueSourceRefs([...(entity.source_refs ?? []), ...(sourceRef ? [sourceRef] : [])])
    this.#record('entities', 'upsert', entity.id, entity, scopeId)
    const record = this.#createObservation(entityId, contents, sourceRef, confidence, scopeId)
    this.#rebuildIndexes()
    return record.id
  }

  lookup(query, limit = 16, scopeId = 'global') {
    const maximum = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 16)
    const text = String(query ?? '').trim()
    if (maximum === 0 || !text) return []
    const scope = normalizeScope(scopeId)
    const ids = new Set()
    const titleId = this.scopeTitleIndex.get(scopedTitle(scope, text))
    if (titleId) ids.add(titleId)
    for (const token of bagTokens(text)) for (const id of this.tokenIndex.get(token) ?? []) if (this.inScope(id, scope)) ids.add(id)
    for (const slot of this.hasher.slotKeys(this.hasher.hash(text))) for (const id of this.hashIndex.get(slot) ?? []) if (this.inScope(id, scope)) ids.add(id)
    return [...ids].slice(0, maximum).map((id) => clone(this.entities.get(id))).filter(Boolean)
  }

  touch(id, scopeId = null) {
    const entity = this.entities.get(id)
    if (!entity || (scopeId !== null && !this.inScope(entity, scopeId))) return null
    entity.hit_count = (entity.hit_count ?? 0) + 1
    entity.last_hit_at = this.#now()
    this.#record('entities', 'upsert', id, entity, recordScope(entity))
    return clone(entity)
  }

  getEntityByName(name, scopeId = 'global') {
    const id = this.scopeTitleIndex.get(scopedTitle(scopeId, name))
    return id ? this.#entityView(this.entities.get(id)) : null
  }

  get(id, scopeId = null) {
    const record = this.entities.get(id) ?? this.relations.get(id) ?? this.observations.get(id) ?? null
    if (!record || (scopeId !== null && recordScope(record) !== normalizeScope(scopeId))) return null
    return record.type === 'entity' ? this.#entityView(record) : clone(record)
  }

  all(scopeId = null) {
    return [...this.entities.values()]
      .filter((entity) => scopeId === null || recordScope(entity) === normalizeScope(scopeId))
      .map((entity) => this.#entityView(entity))
  }

  count(scopeId = null) { return this.all(scopeId).length }

  stats(scopeId = null) {
    const matches = (record) => scopeId === null || recordScope(record) === normalizeScope(scopeId)
    return {
      scopeId: scopeId === null ? null : normalizeScope(scopeId),
      entityCount: [...this.entities.values()].filter(matches).length,
      relationCount: [...this.relations.values()].filter(matches).length,
      observationCount: [...this.observations.values()].filter(matches).length,
      proposalCount: this.proposals.filter((item) => scopeId === null || normalizeScope(item.scopeId) === normalizeScope(scopeId)).length,
      journalSequence: this.sequence,
      journalRecords: this.journalRecordCount,
      pendingMutations: this.dirtyMutations.length,
      recovery: clone(this.recovery),
    }
  }

  readRounds() {
    const path = join(this.indexDir, 'rounds.json')
    if (!existsSync(path)) return { tracked: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { tracked: Array.isArray(parsed?.tracked) ? clone(parsed.tracked) : [] }
  }

  writeRounds(state = { tracked: [] }) {
    const normalized = { tracked: Array.isArray(state?.tracked) ? clone(state.tracked) : [] }
    const path = join(this.indexDir, 'rounds.json')
    atomicWriteJson(path, normalized)
    return path
  }

  writeSource(sourceRef, payload) {
    if (!sourceRef || sourceRef.sessionId === undefined || sourceRef.seq === undefined) throw new TypeError('sourceRef requires sessionId and seq')
    const path = join(this.indexDir, 'source', safeSegment(sourceRef.sessionId), `${safeSegment(sourceRef.seq)}.json`)
    atomicWriteJson(path, payload)
    return path
  }

  readSource(sourceRef) {
    const path = join(this.indexDir, 'source', safeSegment(sourceRef.sessionId), `${safeSegment(sourceRef.seq)}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  }

  dropScope(scopeId) {
    const scope = normalizeScope(scopeId)
    if (scope === 'global') throw new Error('global scope is retained')
    return this.clearScope(scope)
  }

  clearScope(scopeId = 'global') {
    const scope = normalizeScope(scopeId)
    const before = this.stats(scope)
    const scopedRecords = [...this.entities.values(), ...this.relations.values(), ...this.observations.values()]
      .filter((record) => recordScope(record) === scope)
    const targetSourceRefs = new Map()
    for (const record of scopedRecords) for (const sourceRef of record.source_refs ?? []) {
      const key = sourceRefKey(sourceRef)
      if (key) targetSourceRefs.set(key, sourceRef)
    }
    const retainedSourceRefs = new Set()
    for (const record of [...this.entities.values(), ...this.relations.values(), ...this.observations.values()]) {
      if (recordScope(record) === scope) continue
      for (const sourceRef of record.source_refs ?? []) {
        const key = sourceRefKey(sourceRef)
        if (key) retainedSourceRefs.add(key)
      }
    }

    const entityIds = [...this.entities.values()]
      .filter((entity) => recordScope(entity) === scope)
      .map((entity) => entity.id)
    this.removeEntities(entityIds, scope)
    for (const [id, relation] of [...this.relations]) if (recordScope(relation) === scope) {
      this.relations.delete(id)
      this.#record('relations', 'delete', id, null, scope)
    }
    for (const [id, observation] of [...this.observations]) if (recordScope(observation) === scope) {
      this.observations.delete(id)
      this.#record('observations', 'delete', id, null, scope)
    }
    this.proposals = this.proposals.filter((item) => normalizeScope(item.scopeId) !== scope)
    this.writeModes.delete(scope)
    if (scope === 'global') {
      this.writeMode = 'direct'
      this.writeModeReason = null
    }

    let removedSourceFiles = 0
    for (const [key, sourceRef] of targetSourceRefs) {
      if (retainedSourceRefs.has(key)) continue
      const path = join(this.indexDir, 'source', safeSegment(sourceRef.sessionId), `${safeSegment(sourceRef.seq)}.json`)
      if (existsSync(path)) {
        rmSync(path, { force: true })
        removedSourceFiles += 1
      }
    }
    const sourceRoot = join(this.indexDir, 'source')
    if (scope === 'global' && retainedSourceRefs.size === 0) {
      removedSourceFiles += countFiles(sourceRoot)
      rmSync(sourceRoot, { recursive: true, force: true })
      mkdirSync(sourceRoot, { recursive: true })
    } else if (scope !== 'global') {
      const retainedSessionIds = new Set([...retainedSourceRefs].map((key) => key.split('\u0000')[0]))
      if (!retainedSessionIds.has(scope)) {
        const scopeSourceDir = join(sourceRoot, safeSegment(scope))
        removedSourceFiles += countFiles(scopeSourceDir)
        rmSync(scopeSourceDir, { recursive: true, force: true })
      }
    }
    this.#rebuildIndexes()
    this.flush()
    const after = this.stats(scope)
    return {
      scopeId: scope,
      removedEntities: before.entityCount - after.entityCount,
      removedRelations: before.relationCount - after.relationCount,
      removedObservations: before.observationCount - after.observationCount,
      removedProposals: before.proposalCount - after.proposalCount,
      removedSourceFiles,
    }
  }

  backupLegacy(destination) {
    mkdirSync(destination, { recursive: true })
    const copied = []
    for (const file of [...Object.values(JSONL_FILES), 'aliases.json', 'cache.json', 'rounds.json']) {
      const source = join(this.indexDir, file)
      if (!existsSync(source)) continue
      const target = join(destination, file)
      copyFileSync(source, target)
      copied.push(target)
    }
    return copied
  }

  #compact() {
    atomicWriteFile(join(this.indexDir, JSONL_FILES.entities), jsonl([...this.entities.values()]))
    atomicWriteFile(join(this.indexDir, JSONL_FILES.relations), jsonl([...this.relations.values()]))
    atomicWriteFile(join(this.indexDir, JSONL_FILES.observations), jsonl([...this.observations.values()]))
    atomicWriteJson(join(this.indexDir, 'aliases.json'), Object.fromEntries(this.aliases))
    atomicWriteFile(this.journalPath, '')
    this.journalRecordCount = 0
    atomicWriteJson(this.metaPath, {
      version: STORAGE_VERSION,
      migrationVersion: MIGRATION_VERSION,
      sequence: this.sequence,
      journalRecords: 0,
      compactedAt: Date.now(),
    })
  }

  flush() {
    if (this.dirtyMutations.length > 0) {
      const dirty = this.dirtyMutations.splice(0)
      appendAndFsync(this.journalPath, jsonl(dirty))
      this.journalRecordCount += dirty.length
      if (this.config.legacyMirror) {
        for (const collection of Object.keys(JSONL_FILES)) {
          const records = dirty.filter((mutation) => mutation.collection === collection && mutation.op === 'upsert').map((mutation) => mutation.value)
          if (records.length) appendAndFsync(join(this.indexDir, JSONL_FILES[collection]), jsonl(records))
        }
        if (dirty.some((mutation) => mutation.collection === 'aliases')) atomicWriteJson(join(this.indexDir, 'aliases.json'), Object.fromEntries(this.aliases))
      }
    }
    if (this.journalRecordCount >= this.config.journalCompactAfter) this.#compact()
    else atomicWriteJson(this.metaPath, {
      version: STORAGE_VERSION,
      migrationVersion: MIGRATION_VERSION,
      sequence: this.sequence,
      journalRecords: this.journalRecordCount,
      updatedAt: Date.now(),
    })
    return this.stats()
  }
}

export const SENSORY_STORAGE_VERSION = STORAGE_VERSION
