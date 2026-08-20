import { randomUUID } from 'node:crypto'

import { addAssociation } from './memory-policy.js'

const BANK = 'bankRecords'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function normalize(text) { return String(text ?? '').trim().replace(/\s+/g, ' ') }

function tokens(text) {
  const result = new Set()
  for (const match of normalize(text).toLowerCase().matchAll(/[a-z][\w-]*|\d+|[\u4e00-\u9fff]{2,}/g)) result.add(match[0])
  return result
}

function canonicalFacts(text, sourceRefs) {
  const value = normalize(text)
  const facts = []
  let inheritedSubject = null
  for (const clause of value.split(/[，,；;。]+/u).map(normalize).filter(Boolean)) {
    const chinese = clause.match(/^(.{1,80}?)的(.{1,40}?)(?:是|为|位于|使用)(.{1,160})$/u)
    const continuation = inheritedSubject ? clause.match(/^(.{1,40}?)(?:是|为|位于|使用)(.{1,160})$/u) : null
    const standalone = inheritedSubject ? null : clause.match(/^(.{2,80}?)(?:是|为)(.{1,160})$/u)
    const english = clause.match(/^(.{1,80}?)\s+(uses|belongs to|depends on|causes|is)\s+(.{1,160})$/iu)
    const subject = normalize(chinese?.[1] ?? english?.[1] ?? standalone?.[1] ?? inheritedSubject)
    const predicate = normalize(chinese?.[2] ?? english?.[2] ?? continuation?.[1] ?? (standalone ? 'value' : ''))
    const factValue = normalize(chinese?.[3] ?? english?.[3] ?? continuation?.[2] ?? standalone?.[2])
    if (!subject || !predicate || !factValue) continue
    inheritedSubject = subject
    facts.push({
      subject,
      predicate,
      value: factValue,
      validFrom: Date.now(),
      validTo: null,
      current: true,
      sourceRefs: clone(sourceRefs ?? []),
    })
  }
  return facts
}

export class MemoryBank {
  constructor({ ledger, semipersistentLayer = null, config = {} }) {
    this.ledger = ledger
    this.semipersistentLayer = semipersistentLayer
    this.config = { userGlobalEnabled: config.userGlobalEnabled !== false }
  }

  put({ content, scopeKind = 'workspace', scopeId, sourceRefs = [], sessionId = null, workspaceId = null, memoryType = 'verified-fact', explicit = false, recordId = null }) {
    if (scopeKind === 'user-global' && !this.config.userGlobalEnabled) return { stored: false, reason: 'user-global-disabled' }
    const id = recordId ?? `bank-${randomUUID()}`
    const facts = canonicalFacts(content, sourceRefs)
    const record = {
      id,
      recordId: id,
      scopeKind,
      scopeId: String(scopeId),
      workspaceId: workspaceId ? String(workspaceId) : (scopeKind === 'workspace' ? String(scopeId) : null),
      sourceSessionId: sessionId ? String(sessionId) : null,
      memoryType,
      episode: normalize(content),
      canonicalFacts: facts,
      sourceRefs: clone(sourceRefs),
      verifiedSource: sourceRefs.length > 0 || explicit,
      explicit,
      associations: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tombstonedAt: null,
    }
    return { stored: true, record: this.ledger.upsert(BANK, record, { scopeKind, scopeId, id }) }
  }

  listVisible({ workspaceId, includeUserGlobal = true } = {}) {
    const workspace = this.ledger.list(BANK, { scopeKind: 'workspace', scopeId: workspaceId })
    const global = includeUserGlobal && this.config.userGlobalEnabled
      ? this.ledger.list(BANK, { scopeKind: 'user-global' })
      : []
    return [...workspace, ...global].filter((record) => record.verifiedSource && !record.tombstonedAt)
  }

  retrieve(query, { workspaceId, includeUserGlobal = true, limit = 32 } = {}) {
    const queryTokens = tokens(query)
    const ranked = this.listVisible({ workspaceId, includeUserGlobal }).map((record) => {
      const material = [record.episode, ...record.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])].join(' ')
      const recordTokens = tokens(material)
      const overlap = [...queryTokens].filter((token) => recordTokens.has(token)).length
      return { ...record, bank: true, lexicalOverlap: overlap, exact: normalize(material).toLowerCase().includes(normalize(query).toLowerCase()) }
    }).filter((record) => record.lexicalOverlap > 0 || record.exact)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.lexicalOverlap - a.lexicalOverlap)
      .slice(0, limit)
    return ranked
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
      || normalize(record.episode).toLowerCase().includes(normalized)
      || record.canonicalFacts.some((fact) => [fact.subject, fact.predicate, fact.value].some((value) => normalize(value).toLowerCase().includes(normalized))))
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
      workspaceId,
      workspaceRecords: workspace.length,
      userGlobalRecords: global.length,
      tombstones: [...workspace, ...global].filter((record) => record.tombstonedAt).length,
      userGlobalEnabled: this.config.userGlobalEnabled,
    }
  }
}

export const MEMORY_BANK_COLLECTION = BANK
