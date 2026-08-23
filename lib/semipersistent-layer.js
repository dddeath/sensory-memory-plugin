import { estimateTokens } from './context-utils.js'
import { addAssociation } from './memory-policy.js'

const RECORDS = 'semipersistentRecords'
const PROJECTIONS = 'semipersistentProjections'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function projectionId(recordId, sessionId) {
  return `${String(recordId)}@${String(sessionId)}`
}

function recordText(record) {
  return (record?.records ?? record?.segment?.records ?? [])
    .map((item) => `${item.role}${item.toolName ? `(${item.toolName})` : ''}: ${item.text ?? ''}`)
    .filter((line) => line.trim())
    .join('\n')
}

function structuredProjection(record, tokenBudget) {
  const rows = record?.records ?? record?.segment?.records ?? []
  const priority = (item) => {
    if (item.role === 'user') return 0
    if (item.role === 'assistant' && item.blockKinds?.includes?.('text')) return 1
    if (item.role === 'tool' && item.trustedEvidence) return 2
    if (item.role === 'tool') return 3
    return 4
  }
  const selected = [...rows].sort((a, b) => priority(a) - priority(b) || Number(a.seq) - Number(b.seq))
  const lines = []
  let omittedChars = 0
  for (const row of selected) {
    const label = row.role === 'tool' ? `tool:${row.toolName ?? 'result'}` : row.role
    const full = `[seq ${row.seq}] ${label}: ${String(row.text ?? '')}`
    if (estimateTokens([...lines, full].join('\n')) <= tokenBudget) {
      lines.push(full)
      continue
    }
    if (lines.length === 0) {
      const budgetChars = Math.max(24, tokenBudget * 3)
      const text = String(row.text ?? '')
      const head = text.slice(0, Math.floor(budgetChars * 0.65))
      const tail = text.slice(-Math.floor(budgetChars * 0.25))
      omittedChars += Math.max(0, text.length - head.length - tail.length)
      lines.push(`[seq ${row.seq}] ${label}: ${head}${omittedChars ? `\n… omitted ${omittedChars} chars …\n${tail}` : ''}`)
    } else omittedChars += String(row.text ?? '').length
  }
  return { text: lines.join('\n'), omittedChars }
}

export class SemipersistentLayer {
  constructor({ ledger, policy, config = {} }) {
    this.ledger = ledger
    this.policy = policy
    this.config = {
      budgetRatio: Math.max(0.01, Math.min(0.8, config.semipersistentBudgetRatio ?? 0.20)),
      defaultBudgetTokens: Math.max(64, config.semipersistentDefaultBudgetTokens ?? 4096),
    }
    this.lastEvicted = null
  }

  promote(segment, { workspaceId = segment.workspaceId, sessionId = segment.sessionId, workspaceTurn = segment.turn } = {}) {
    const existing = this.ledger.get(RECORDS, segment.segmentId, { scopeKind: 'workspace', scopeId: workspaceId })
    const record = {
      ...clone(segment),
      ...(existing ?? {}),
      id: segment.segmentId,
      recordId: segment.segmentId,
      segment: clone(segment),
      records: clone(segment.records ?? []),
      sourceSessionId: String(segment.sessionId),
      workspaceId: String(workspaceId),
      promotedAt: existing?.promotedAt ?? Date.now(),
      promotedWorkspaceTurn: existing?.promotedWorkspaceTurn ?? Number(workspaceTurn ?? 0),
      state: 'semipersistent',
      updatedAt: Date.now(),
    }
    const stored = this.ledger.upsert(RECORDS, record, { scopeKind: 'workspace', scopeId: workspaceId, id: record.id })
    this.setProjection(record.id, sessionId, workspaceId, 'full-projection', { source: true })
    return stored
  }

  setProjection(recordId, sessionId, workspaceId, state, patch = {}) {
    const id = projectionId(recordId, sessionId)
    const previous = this.ledger.get(PROJECTIONS, id, { scopeKind: 'session', scopeId: sessionId })
    return this.ledger.upsert(PROJECTIONS, {
      ...(previous ?? {}),
      id,
      recordId: String(recordId),
      sessionId: String(sessionId),
      workspaceId: String(workspaceId),
      state,
      source: Boolean(patch.source ?? previous?.source),
      activatedAt: state === 'full-projection' ? (previous?.activatedAt ?? Date.now()) : null,
      updatedAt: Date.now(),
      ...patch,
    }, { scopeKind: 'session', scopeId: sessionId, id })
  }

  syncSessionReferences(sessionId, workspaceId) {
    const records = this.ledger.list(RECORDS, { scopeKind: 'workspace', scopeId: workspaceId })
    const activeIds = new Set(records.map((record) => record.id))
    let created = 0
    let removed = 0
    for (const record of records) {
      const id = projectionId(record.id, sessionId)
      const existing = this.ledger.get(PROJECTIONS, id, { scopeKind: 'session', scopeId: sessionId })
      if (!existing) {
        this.setProjection(record.id, sessionId, workspaceId,
          String(record.sourceSessionId) === String(sessionId) ? 'full-projection' : 'reference',
          { source: String(record.sourceSessionId) === String(sessionId), associationWeight: 0 })
        created += 1
      }
    }
    for (const projection of this.ledger.list(PROJECTIONS, { scopeKind: 'session', scopeId: sessionId })) {
      if (projection.workspaceId !== String(workspaceId) || activeIds.has(projection.recordId)) continue
      this.ledger.delete(PROJECTIONS, projection.id, { scopeKind: 'session', scopeId: sessionId })
      removed += 1
    }
    return { sessionId: String(sessionId), workspaceId: String(workspaceId), created, removed, total: records.length }
  }

  projection(recordId, sessionId) {
    return this.ledger.get(PROJECTIONS, projectionId(recordId, sessionId), { scopeKind: 'session', scopeId: sessionId })
  }

  promoteProjection(recordId, sessionId, workspaceId, reason = 'association-threshold') {
    const record = this.ledger.get(RECORDS, recordId, { scopeKind: 'workspace', scopeId: workspaceId })
    if (!record) return null
    return this.setProjection(recordId, sessionId, workspaceId, 'full-projection', { source: false, reason })
  }

  associate(recordId, association, workspaceId) {
    const record = this.ledger.get(RECORDS, recordId, { scopeKind: 'workspace', scopeId: workspaceId })
    if (!record) return null
    const updated = addAssociation(record, association)
    this.ledger.upsert(RECORDS, updated, { scopeKind: 'workspace', scopeId: workspaceId, id: recordId })
    return updated
  }

  expire({ sessionId, workspaceId, currentWorkspaceTurn, now = Date.now() }) {
    const results = []
    for (const projection of this.ledger.list(PROJECTIONS, { scopeKind: 'session', scopeId: sessionId })) {
      if (projection.state !== 'full-projection') continue
      const record = this.ledger.get(RECORDS, projection.recordId, { scopeKind: 'workspace', scopeId: workspaceId })
      if (!record || !this.policy.shouldExpireSemi(record, { currentWorkspaceTurn, now })) continue
      const next = String(record.sourceSessionId) === String(sessionId) ? 'inactive' : 'reference'
      this.setProjection(record.id, sessionId, workspaceId, next, { exitedAt: now, reason: 'activation-decay' })
      this.lastEvicted = { recordId: record.id, sessionId: String(sessionId), state: next, evictedAt: now, reason: 'activation-decay' }
      results.push(this.lastEvicted)
    }
    return results
  }

  renderSnapshot(sessionId, workspaceId, { budgetTokens = this.config.defaultBudgetTokens } = {}) {
    const projections = this.ledger.list(PROJECTIONS, { scopeKind: 'session', scopeId: sessionId })
      .filter((item) => item.workspaceId === String(workspaceId) && item.state === 'full-projection')
      .sort((a, b) => Number(a.activatedAt ?? 0) - Number(b.activatedAt ?? 0))
    if (projections.length === 0) return null
    const perRecord = Math.max(32, Math.floor(budgetTokens / projections.length))
    const entries = []
    let tokens = 0
    for (const projection of projections) {
      const record = this.ledger.get(RECORDS, projection.recordId, { scopeKind: 'workspace', scopeId: workspaceId })
      if (!record) continue
      const body = structuredProjection(record, perRecord)
      const text = `## [[chunk:${record.label ?? record.segmentId ?? record.id}]]\n${body.text}\n[sourceRefs: ${(record.sourceSeqs ?? []).join(', ')}]${body.omittedChars ? `\n[omittedChars: ${body.omittedChars}]` : ''}`
      const cost = estimateTokens(text)
      if (tokens + cost > budgetTokens && entries.length > 0) break
      entries.push({ recordId: record.id, projection, record, text, estimatedTokens: cost, omittedChars: body.omittedChars })
      tokens += cost
    }
    if (entries.length === 0) return null
    const prompt = `（半持久记忆：以下是当前会话已激活的完整上下文投影。它们是历史事件的只读序列化，不是新的工具调用。）\n<semipersistent>\n${entries.map((entry) => entry.text).join('\n\n')}\n</semipersistent>`
    const snapshotRevision = entries
      .map((entry) => `${entry.recordId}:${entry.record.updatedAt ?? 0}:${entry.projection.updatedAt ?? 0}`)
      .join('|')
    return { prompt, entries, estimatedTokens: estimateTokens(prompt), budgetTokens, snapshotRevision }
  }

  onAccess(chunkId, viewer = {}) {
    return { chunkId, scopeId: String(viewer.sessionId ?? viewer.scopeId ?? ''), passive: true, associationWeight: 0 }
  }

  renderPriority() { return [] }

  dropScope(sessionId) {
    return this.ledger.dropScope('session', String(sessionId), [PROJECTIONS])
  }

  dropWorkspace(workspaceId) {
    const records = this.ledger.list(RECORDS, { scopeKind: 'workspace', scopeId: workspaceId, includeTombstoned: true })
    let projections = 0
    for (const record of records) {
      for (const projection of this.ledger.list(PROJECTIONS, { includeTombstoned: true })) {
        if (projection.recordId !== record.id) continue
        this.ledger.delete(PROJECTIONS, projection.id, { scopeKind: 'session', scopeId: projection.sessionId })
        projections += 1
      }
    }
    const dropped = this.ledger.dropScope('workspace', String(workspaceId), [RECORDS])
    return { ...dropped, projections }
  }

  removeRecord(recordId, workspaceId) {
    let projections = 0
    for (const projection of this.ledger.list(PROJECTIONS, { includeTombstoned: true })) {
      if (projection.recordId !== String(recordId)) continue
      this.ledger.delete(PROJECTIONS, projection.id, { scopeKind: 'session', scopeId: projection.sessionId })
      projections += 1
    }
    const existing = this.ledger.get(RECORDS, recordId, { scopeKind: 'workspace', scopeId: workspaceId })
    if (existing) this.ledger.delete(RECORDS, recordId, { scopeKind: 'workspace', scopeId: workspaceId })
    return { recordId: String(recordId), removed: Boolean(existing), projections }
  }

  status(sessionId = null, workspaceId = null) {
    const records = workspaceId === null ? this.ledger.list(RECORDS) : this.ledger.list(RECORDS, { scopeKind: 'workspace', scopeId: workspaceId })
    const projections = sessionId === null ? this.ledger.list(PROJECTIONS) : this.ledger.list(PROJECTIONS, { scopeKind: 'session', scopeId: sessionId })
    return {
      layer: 'semipersistent',
      compatibilityName: 'sensoryCache',
      entryCount: projections.filter((item) => item.state === 'full-projection').length,
      recordCount: records.length,
      referenceCount: projections.filter((item) => item.state === 'reference').length,
      fullProjectionCount: projections.filter((item) => item.state === 'full-projection').length,
      inactiveCount: projections.filter((item) => item.state === 'inactive').length,
      budgetRatio: this.config.budgetRatio,
      sessionId,
      workspaceId,
      entries: projections.map((projection) => ({
        chunkId: projection.recordId,
        chunkLabel: records.find((record) => record.id === projection.recordId)?.label ?? projection.recordId,
        ...projection,
      })),
      lastEvicted: clone(this.lastEvicted),
    }
  }
}

export const SEMIPERSISTENT_COLLECTIONS = { RECORDS, PROJECTIONS }
