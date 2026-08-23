import { randomUUID } from 'node:crypto'

import { addAssociation } from './memory-policy.js'
import { ContextChunker } from './context-chunker.js'

const BANK = 'bankChunks'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function normalize(text) { return String(text ?? '').trim().replace(/\s+/g, ' ') }

export class MemoryBank {
  constructor({ ledger, semipersistentLayer = null, chunker = new ContextChunker(), vectorEncoder = null, config = {} }) {
    this.ledger = ledger
    this.semipersistentLayer = semipersistentLayer
    this.chunker = chunker
    this.vectorEncoder = vectorEncoder
    this.config = { userGlobalEnabled: config.userGlobalEnabled !== false }
  }

  #prepare({ content, chunk, scopeKind, recordId }) {
    if (scopeKind === 'user-global' && !this.config.userGlobalEnabled) return { stored: false, reason: 'user-global-disabled' }
    const id = recordId ?? `bank-chunk-${randomUUID()}`
    const prepared = chunk ?? this.chunker.chunk(content, { segmentId: id })[0]
    if (!prepared) return { stored: false, reason: 'empty-chunk' }
    return { id, prepared }
  }

  #persist({ content, scopeKind, scopeId, sourceRefs, sessionId, workspaceId, memoryType, explicit }, id, prepared, vector) {
    const record = {
      ...clone(prepared),
      id,
      chunkId: id,
      kind: 'context-chunk',
      layer: 'bank',
      scopeKind,
      scopeId: String(scopeId),
      workspaceId: workspaceId ? String(workspaceId) : (scopeKind === 'workspace' ? String(scopeId) : null),
      sourceSessionId: sessionId ? String(sessionId) : null,
      memoryType,
      coreText: normalize(prepared.coreText ?? content),
      contextText: String(prepared.contextText ?? prepared.coreText ?? content),
      label: prepared.label ?? normalize(prepared.coreText ?? content).slice(0, 80),
      vector,
      vectorKey: vector ? `${vector.model}:${id}` : null,
      sourceRefs: clone(sourceRefs.length ? sourceRefs : prepared.sourceRefs ?? []),
      evidenceQuality: Number(prepared.evidenceQuality ?? (sourceRefs.length > 0 || explicit ? 1 : 0)),
      verifiedSource: sourceRefs.length > 0 || explicit,
      explicit,
      temporalCurrent: true,
      supersededBy: null,
      associations: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tombstonedAt: null,
    }
    return { stored: true, record: this.ledger.upsert(BANK, record, { scopeKind, scopeId, id }) }
  }

  put({ content, chunk = null, scopeKind = 'workspace', scopeId, sourceRefs = [], sessionId = null, workspaceId = null, memoryType = 'durable-context', explicit = false, recordId = null }) {
    const input = { content, chunk, scopeKind, scopeId, sourceRefs, sessionId, workspaceId, memoryType, explicit, recordId }
    const prepared = this.#prepare(input)
    if (prepared.stored === false) return prepared
    const vector = prepared.prepared.vector ?? (typeof this.vectorEncoder?.encodeSync === 'function'
      ? this.vectorEncoder.encodeSync(prepared.prepared.contextText)
      : null)
    return this.#persist(input, prepared.id, prepared.prepared, vector)
  }

  async putAsync({ content, chunk = null, scopeKind = 'workspace', scopeId, sourceRefs = [], sessionId = null, workspaceId = null, memoryType = 'durable-context', explicit = false, recordId = null }) {
    const input = { content, chunk, scopeKind, scopeId, sourceRefs, sessionId, workspaceId, memoryType, explicit, recordId }
    const prepared = this.#prepare(input)
    if (prepared.stored === false) return prepared
    let vector = prepared.prepared.vector ?? null
    if (!vector && typeof this.vectorEncoder?.encodeSync === 'function') {
      vector = this.vectorEncoder.encodeSync(prepared.prepared.contextText)
    } else if (!vector && typeof this.vectorEncoder?.encodeBatch === 'function') {
      vector = (await this.vectorEncoder.encodeBatch([prepared.prepared.contextText]))[0] ?? null
    } else if (!vector && typeof this.vectorEncoder?.encode === 'function') {
      vector = await this.vectorEncoder.encode(prepared.prepared.contextText)
    }
    return this.#persist(input, prepared.id, prepared.prepared, vector)
  }

  listVisible({ workspaceId, includeUserGlobal = true } = {}) {
    const workspace = this.ledger.list(BANK, { scopeKind: 'workspace', scopeId: workspaceId })
    const global = includeUserGlobal && this.config.userGlobalEnabled
      ? this.ledger.list(BANK, { scopeKind: 'user-global' })
      : []
    return [...workspace, ...global].filter((record) => record.verifiedSource && record.temporalCurrent !== false && !record.supersededBy && !record.tombstonedAt)
  }

  retrieve(query, { workspaceId, includeUserGlobal = true, limit = 32 } = {}) {
    const normalized = normalize(query).toLowerCase()
    return this.listVisible({ workspaceId, includeUserGlobal })
      .filter((record) => normalize(record.coreText).toLowerCase().includes(normalized))
      .slice(0, limit)
  }

  open(recordId, { workspaceId, sessionId, turn, weight = 1 } = {}) {
    const record = this.listVisible({ workspaceId }).find((item) => item.id === String(recordId))
    if (!record) return null
    const updated = addAssociation(record, { sessionId, workspaceId, turn, weight, kind: 'bank-open', verified: true })
    this.ledger.upsert(BANK, updated, { scopeKind: record.scopeKind, scopeId: record.scopeId, id: record.id })
    return updated
  }

  forget(target, { workspaceId, scope = 'workspace' } = {}) {
    const visible = scope === 'user-global'
      ? this.ledger.list(BANK, { scopeKind: 'user-global' })
      : this.ledger.list(BANK, { scopeKind: 'workspace', scopeId: workspaceId })
    const normalized = normalize(target).toLowerCase()
    const matches = visible.filter((record) => record.id === target
      || normalize(record.coreText).toLowerCase().includes(normalized))
    for (const record of matches) {
      this.ledger.upsert(BANK, { ...record, tombstonedAt: Date.now(), tombstoneReason: 'explicit-forget', updatedAt: Date.now() }, {
        scopeKind: record.scopeKind, scopeId: record.scopeId, id: record.id,
      })
    }
    return { target, scope, tombstoned: matches.map((record) => record.id) }
  }

  dropWorkspace(workspaceId) {
    return this.ledger.dropScope('workspace', String(workspaceId), [BANK])
  }

  status(workspaceId = null) {
    const workspace = workspaceId === null ? this.ledger.list(BANK, { scopeKind: 'workspace' }) : this.ledger.list(BANK, { scopeKind: 'workspace', scopeId: workspaceId })
    const global = this.ledger.list(BANK, { scopeKind: 'user-global' })
    return {
      architecture: 'chunk-only-vector',
      workspaceId,
      workspaceChunks: workspace.length,
      userGlobalChunks: global.length,
      workspaceRecords: workspace.length,
      userGlobalRecords: global.length,
      tombstones: [...workspace, ...global].filter((record) => record.tombstonedAt).length,
      userGlobalEnabled: this.config.userGlobalEnabled,
    }
  }
}

export const MEMORY_BANK_COLLECTION = BANK
