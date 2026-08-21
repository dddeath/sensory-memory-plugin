import { resolve } from 'node:path'

import { estimateTokens } from './injection-engine.js'
import { addAssociation, parseRememberDirective } from './memory-policy.js'
import { SENSORY_LEDGER_COLLECTION } from './layered-match-engine.js'

const SEGMENTS = 'sourceSegments'
const SESSION_STATE = 'sessionState'

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

function textOf(message) {
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').filter(Boolean).join(' ')
}

function currentUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index]?.source?.kind !== 'plugin') return textOf(messages[index]).trim()
  }
  return ''
}

function normalizedWorkspaceFallback(cwd) {
  return `path:${resolve(String(cwd ?? process.cwd())).replace(/\\/g, '/').toLowerCase()}`
}

function sourceRefs(segment) {
  return (segment.sourceSeqs ?? []).map((seq) => ({ sessionId: segment.sessionId, seq }))
}

function canonicalSourceRefs(segment, trustedEvidenceTools = []) {
  return (segment.records ?? [])
    .filter((record) => (record.role === 'user' && record.sourceKind === 'user')
      || (record.role === 'tool' && trustedEvidenceTools.includes(String(record.toolName ?? ''))))
    .map((record) => ({ sessionId: segment.sessionId, seq: record.seq }))
}

function titleFor(segment, entity, index) {
  return entity?.name ?? `session-${segment.sessionId}-turn-${segment.turn}-${index + 1}`
}

function factFromEntity(entity, segment, trustedEvidenceTools = []) {
  const observation = String(entity?.observations?.[0] ?? '').trim()
  if (!observation) return []
  return [{
    subject: entity.name,
    predicate: 'states',
    value: observation,
    validFrom: segment.createdAt,
    validTo: null,
    current: true,
    sourceRefs: canonicalSourceRefs(segment, trustedEvidenceTools),
  }]
}

function meaningfulEntity(entity) {
  const name = String(entity?.name ?? '').trim()
  if (!name || /^(?:in|to|on|a|user|llm)$/iu.test(name) || /^[a-z]$/iu.test(name)) return false
  if (/^(?:https?:\/\/|[a-z]:\\|\/|\.\.?\/)/iu.test(name)) return false
  return true
}

export class LayeredMemoryRuntime {
  constructor({ ctx, config = {}, ledger, segmenter, policy, semipersistentLayer, bank, surfaceProjector, matcher, planner, transitionReviewer = null, index, extractor, sourceStore, debug = null, auxiliaryRequests = null }) {
    this.ctx = ctx
    this.config = {
      transitionWaitMs: Math.max(1, config.transitionWaitMs ?? 5000),
      trustedEvidenceTools: Array.isArray(config.trustedEvidenceTools) ? config.trustedEvidenceTools.map(String) : [],
      userGlobalEnabled: config.userGlobalEnabled !== false,
      llmProvider: config.llmProvider ?? config.provider ?? null,
      llmModel: config.llmModel ?? config.model ?? null,
      defaultContextWindow: Math.max(1024, config.contextWindow ?? config.defaultContextWindow ?? 128_000),
      defaultMaxOutputTokens: Math.max(1, config.maxOutputTokens ?? config.defaultMaxOutputTokens ?? 8_192),
      indexScope: 'session',
    }
    this.ledger = ledger
    this.segmenter = segmenter
    this.policy = policy
    this.semipersistentLayer = semipersistentLayer
    this.bank = bank
    this.surfaceProjector = surfaceProjector
    this.matcher = matcher
    this.planner = planner
    this.transitionReviewer = transitionReviewer
    this.index = index
    this.extractor = extractor
    this.sourceStore = sourceStore
    this.debug = debug
    this.auxiliaryRequests = auxiliaryRequests
    this.lastEvidence = new Map()
    this.lastTransitions = new Map()
    this.workspaceTurns = new Map()
    this.sessionAuxiliaryPurposes = new Map()
    this.frozenSessions = new Set()
    this.sessions = new Map()
    this.stats = {
      preSteps: 0,
      turns: 0,
      transitionTimeouts: 0,
      workingToSensory: 0,
      workingToSemi: 0,
      sensoryToSemi: 0,
      semiToBank: 0,
      explicitBankWrites: 0,
      surfaceRevisionDrifts: 0,
      externalCompactionToSensory: 0,
      auxiliaryPurposes: { 'memory-transition-review': 0, 'memory-retrieval-plan': 0, 'memory-audit': 0 },
    }
  }

  #recordAuxiliary(sessionId, purpose, count) {
    const delta = Math.max(0, Number(count ?? 0))
    if (delta === 0) return
    this.stats.auxiliaryPurposes[purpose] = Number(this.stats.auxiliaryPurposes[purpose] ?? 0) + delta
    const current = this.sessionAuxiliaryPurposes.get(String(sessionId)) ?? {
      'memory-transition-review': 0,
      'memory-retrieval-plan': 0,
      'memory-audit': 0,
    }
    current[purpose] = Number(current[purpose] ?? 0) + delta
    this.sessionAuxiliaryPurposes.set(String(sessionId), current)
  }

  async workspace(agent) {
    const cwd = agent?.cwd ?? agent?.session?.header?.cwd ?? process.cwd()
    try {
      const value = await this.ctx?.workspaceRegistry?.resolveByPath?.(cwd)
      if (value) return { workspaceId: String(value.id ?? value.workspaceId ?? value.path ?? normalizedWorkspaceFallback(cwd)), cwd, resolution: 'workspace-registry' }
    } catch (error) {
      this.ctx?.logger?.warn?.('[sensory-memory] workspace resolution failed: %s', String(error))
    }
    return { workspaceId: normalizedWorkspaceFallback(cwd), cwd, resolution: 'fallback-path' }
  }

  sessionState(sessionId) {
    return this.ledger.get(SESSION_STATE, String(sessionId), { scopeKind: 'session', scopeId: sessionId }) ?? {
      id: String(sessionId), sessionId: String(sessionId), archived: false, taskStateRevision: 0, lastTurn: 0, workspaceId: null,
    }
  }

  setSessionState(sessionId, patch) {
    const state = { ...this.sessionState(sessionId), ...patch, id: String(sessionId), sessionId: String(sessionId), updatedAt: Date.now() }
    return this.ledger.upsert(SESSION_STATE, state, { scopeKind: 'session', scopeId: sessionId, id: sessionId })
  }

  #segments(sessionId) { return this.ledger.list(SEGMENTS, { scopeKind: 'session', scopeId: sessionId }) }

  #storeSegment(segment) {
    return this.ledger.upsert(SEGMENTS, segment, { scopeKind: 'session', scopeId: segment.sessionId, id: segment.id })
  }

  #extractSegmentMetadata(segment) {
    const userText = segment.records.filter((record) => record.role === 'user' && record.sourceKind === 'user').map((record) => record.text).join('\n')
    const directive = parseRememberDirective(userText)
    const extractionText = directive?.content ?? userText
    const userSeq = segment.records.find((record) => record.role === 'user' && record.sourceKind === 'user')?.seq ?? segment.firstSeq
    const extracted = this.extractor.extractFromText(extractionText, { sessionId: segment.sessionId, seq: userSeq, role: 'user' })
    const entities = (extracted.entities ?? []).filter(meaningfulEntity)
    const title = entities[0]?.name ?? `session-${segment.sessionId}-turn-${segment.turn}`
    return {
      ...segment,
      title,
      entities,
      canonicalFacts: entities.flatMap((entity) => factFromEntity(entity, segment, this.config.trustedEvidenceTools)),
      episodeSummary: userText.slice(0, 500),
      approvedEpisode: Boolean(userText.trim()),
      memoryType: /(?:偏好|喜欢|prefer)/iu.test(userText) ? 'preference' : 'verified-fact',
      evidenceQuality: userText.trim() ? Math.max(0.85, Number(segment.evidenceQuality ?? 0)) : Number(segment.evidenceQuality ?? 0),
      verifiedSource: Boolean(userText.trim()),
    }
  }

  #sensoryEntriesFor(segment) {
    const entities = segment.entities?.length ? segment.entities : [{ name: segment.title, observations: [], aliases: [], checkpointOnly: true }]
    return entities.filter(meaningfulEntity).map((entity, index) => ({
      id: `${segment.id}:sensory:${index}`,
      kind: 'checkpoint',
      scopeKind: 'session',
      scopeId: segment.sessionId,
      sessionId: segment.sessionId,
      workspaceId: segment.workspaceId,
      segmentId: segment.id,
      title: titleFor(segment, entity, index),
      aliases: entity.aliases ?? [],
      canonicalFacts: entity.checkpointOnly
        ? clone(segment.canonicalFacts ?? [])
        : factFromEntity(entity, segment, this.config.trustedEvidenceTools),
      episodeSummary: String(entity.observations?.[0] ?? segment.episodeSummary ?? '').slice(0, 500),
      approvedEpisode: true,
      sourceRefs: sourceRefs(segment),
      firstSeq: segment.firstSeq,
      lastSeq: segment.lastSeq,
      span: [segment.firstSeq, segment.lastSeq],
      parentId: null,
      level: 0,
      evidenceQuality: segment.evidenceQuality,
      verifiedSource: segment.verifiedSource,
      associations: clone(segment.associations ?? []),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }))
  }

  #mirrorSensory(entry) {
    const observations = [entry.episodeSummary, ...entry.canonicalFacts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.value}`)].filter(Boolean)
    const id = this.index.addEntity({
      name: entry.title,
      aliases: entry.aliases,
      observations,
      sourceRef: entry.sourceRefs[0],
      source_refs: entry.sourceRefs,
      scopeId: entry.sessionId,
      confidence: entry.evidenceQuality,
      keywords: [],
    })
    for (const ref of entry.sourceRefs) {
      const record = this.#segments(entry.sessionId).find((segment) => segment.id === entry.segmentId)?.records.find((item) => item.seq === ref.seq)
      if (record) this.index.writeSource(ref, { kind: 'layered-v2', role: record.role, text: record.text, segmentId: entry.segmentId })
    }
    return id
  }

  #persistSensoryEntries(entries) {
    const stored = []
    for (const entry of entries) {
      const legacyEntityId = this.#mirrorSensory(entry)
      stored.push(this.ledger.upsert(SENSORY_LEDGER_COLLECTION, { ...entry, legacyEntityId }, { scopeKind: 'session', scopeId: entry.sessionId, id: entry.id }))
    }
    this.index.flush()
    return stored
  }

  async #resolveModelContext(signal) {
    const provider = this.config.llmProvider ?? null
    const model = this.config.llmModel ?? null
    if (provider && model) {
      try {
        const resolved = await (this.ctx?.llm?.resolveModelInfo?.(provider, model, signal)
          ?? this.ctx?.llm?.resolveModel?.(provider, model, signal))
        return {
          provider,
          model,
          contextWindow: resolved?.context?.contextWindow ?? resolved?.contextWindow ?? this.config.defaultContextWindow,
          maxOutputTokens: resolved?.defaultMaxTokens ?? resolved?.maxTokens ?? this.config.defaultMaxOutputTokens,
        }
      } catch {}
    }
    return { provider, model, contextWindow: this.config.defaultContextWindow, maxOutputTokens: this.config.defaultMaxOutputTokens }
  }

  #recordBackReferences(query, { sessionId, workspaceId, turn }) {
    const normalized = String(query).toLowerCase()
    const transitions = []
    for (const segment of this.#segments(sessionId)) {
      if (!segment.title || !normalized.includes(String(segment.title).toLowerCase())) continue
      const updated = addAssociation(segment, { sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind: 'user-back-reference', weight: 1, verified: true })
      this.#storeSegment(updated)
      transitions.push({ itemId: segment.id, association: 'user-back-reference', deduplicated: updated.associationDeduplicated })
    }
    for (const entry of this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId })) {
      if (!entry.title || !normalized.includes(String(entry.title).toLowerCase())) continue
      const updated = addAssociation(entry, { sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind: 'user-back-reference', weight: 1, verified: true })
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, updated, { scopeKind: 'session', scopeId: sessionId, id: entry.id })
      const segment = this.ledger.get(SEGMENTS, entry.segmentId, { scopeKind: 'session', scopeId: entry.sessionId })
      if (segment) {
        const associated = addAssociation(segment, { sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind: 'user-back-reference', weight: 1, verified: true })
        this.#storeSegment(associated)
        if (this.policy.shouldPromoteToSemi(associated, { currentTurn: turn })) {
          this.semipersistentLayer.promote(associated, { workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspaceId) ?? turn })
          this.semipersistentLayer.promoteProjection(associated.id, sessionId, workspaceId, 'sensory-association-threshold')
          this.stats.sensoryToSemi += 1
        }
      }
    }
    for (const projection of this.ledger.list('semipersistentProjections', { scopeKind: 'session', scopeId: sessionId })) {
      if (!['reference', 'full-projection'].includes(projection.state) || projection.workspaceId !== String(workspaceId)) continue
      const record = this.ledger.get('semipersistentRecords', projection.recordId, { scopeKind: 'workspace', scopeId: workspaceId })
      if (!record?.title || !normalized.includes(String(record.title).toLowerCase())) continue
      const associated = this.semipersistentLayer.associate(record.id, {
        sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind: 'user-back-reference', weight: 1, verified: true,
      }, workspaceId)
      if (projection.state === 'reference' && this.policy.shouldPromoteToSemi(associated, { currentTurn: turn })) {
        this.semipersistentLayer.promoteProjection(record.id, sessionId, workspaceId, 'target-session-association-threshold')
      }
      if (this.policy.shouldPromoteToBank(associated, { currentTurn: turn })) this.#promoteSemiToBank(associated, sessionId, workspaceId)
    }
    return transitions
  }

  #promoteSemiToBank(record, sessionId, workspaceId) {
    if (record.bankRecordId) return record.bankRecordId
    const content = record.canonicalFacts?.length
      ? record.canonicalFacts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.value}`).join('；')
      : record.episodeSummary ?? record.title
    const stored = this.bank.put({
      content,
      scopeKind: 'workspace',
      scopeId: workspaceId,
      sourceRefs: sourceRefs(record),
      sessionId,
      workspaceId,
      memoryType: record.memoryType,
      explicit: false,
      recordId: `bank:${record.id}`,
    })
    if (stored.stored) {
      this.ledger.upsert('semipersistentRecords', { ...record, bankRecordId: stored.record.id, updatedAt: Date.now() }, { scopeKind: 'workspace', scopeId: workspaceId, id: record.id })
      this.stats.semiToBank += 1
      return stored.record.id
    }
    return null
  }

  #materializeBankSelection(candidate, sessionId, workspaceId, turn) {
    if (candidate.layer !== 'bank') return null
    const record = candidate.raw
    const semiRecord = {
      id: `bank-materialized:${record.id}`,
      segmentId: `bank-materialized:${record.id}`,
      sessionId: record.sourceSessionId ?? sessionId,
      sourceSessionId: record.sourceSessionId ?? sessionId,
      workspaceId,
      title: candidate.title,
      turn,
      sourceSeqs: (record.sourceRefs ?? []).map((ref) => ref.seq),
      records: [{ seq: (record.sourceRefs ?? [])[0]?.seq ?? 0, role: 'user', text: record.episode, blockKinds: ['text'], sourceKind: 'bank' }],
      canonicalFacts: record.canonicalFacts ?? [],
      episodeSummary: record.episode,
      evidenceQuality: 0.9,
      durability: 0.9,
      importance: 0.9,
      verifiedSource: true,
      memoryType: record.memoryType,
      associations: record.associations ?? [],
      state: 'semipersistent',
      createdAt: record.createdAt,
      updatedAt: Date.now(),
    }
    this.semipersistentLayer.promote(semiRecord, { workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspaceId) ?? turn })
    return semiRecord.id
  }

  #transitionWorking(session, segment, currentTurn, budget) {
    if (this.policy.shouldPromoteToSemi(segment, { currentTurn })) {
      const text = this.surfaceProjector.semipersistentPointer(segment)
      const replaced = this.surfaceProjector.replaceSegment(session, segment, { purpose: 'semipersistent-pointer', text, transition: 'working-to-semipersistent' })
      if (!replaced.ok) { if (replaced.reason === 'surface-revision-drift') this.stats.surfaceRevisionDrifts += 1; return replaced }
      const updated = { ...segment, state: 'semipersistent', surfaceRevision: replaced.surfaceRevision, replacementLineage: [...(segment.replacementLineage ?? []), replaced.lineage], updatedAt: Date.now() }
      this.#storeSegment(updated)
      this.semipersistentLayer.promote(updated, { workspaceId: segment.workspaceId, sessionId: segment.sessionId, workspaceTurn: this.workspaceTurns.get(segment.workspaceId) ?? currentTurn })
      this.stats.workingToSemi += 1
      return { ok: true, transition: 'working-to-semipersistent', segmentId: segment.id, lineage: replaced.lineage }
    }
    if (!this.policy.shouldMoveWorkingToSensory(segment, { currentTurn, contextPressure: budget?.pressureTriggered })) return null
    const entries = this.#sensoryEntriesFor(segment)
    if (entries.length === 0) return { ok: false, reason: 'no-indexable-evidence', segmentId: segment.id }
    const text = this.surfaceProjector.sensoryCheckpoint(entries[0])
    const replaced = this.surfaceProjector.replaceSegment(session, segment, { purpose: 'sensory-checkpoint', text, transition: budget?.pressureTriggered ? 'context-pressure' : 'working-to-sensory' })
    if (!replaced.ok) { if (replaced.reason === 'surface-revision-drift') this.stats.surfaceRevisionDrifts += 1; return replaced }
    this.#persistSensoryEntries(entries)
    const updated = { ...segment, state: 'sensory', surfaceRevision: replaced.surfaceRevision, replacementLineage: [...(segment.replacementLineage ?? []), replaced.lineage], updatedAt: Date.now() }
    this.#storeSegment(updated)
    this.stats.workingToSensory += 1
    return { ok: true, transition: 'working-to-sensory', segmentId: segment.id, entryIds: entries.map((entry) => entry.id), lineage: replaced.lineage }
  }

  #processTransitions(session, currentTurn, budget, model = null) {
    const results = []
    const working = this.#segments(session.id).filter((segment) => segment.state === 'working').sort((a, b) => Number(a.firstSeq) - Number(b.firstSeq))
    let currentBudget = budget
    for (const segment of working) {
      const result = this.#transitionWorking(session, segment, currentTurn, currentBudget)
      if (result) results.push(result)
      if (currentBudget?.pressureTriggered && result?.ok && model) {
        currentBudget = this.surfaceProjector.budget({
          sessionId: session.id,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          request: { messages: session.deriveMessages?.() ?? [] },
        })
        if (currentBudget.estimatedInputTokens <= currentBudget.pressureTargetTokens) break
      }
    }
    this.lastTransitions.set(String(session.id), results)
    return results
  }

  #reconcileExternalCompaction(session, reconcile) {
    const ranges = reconcile?.externalCompactionRanges ?? []
    if (ranges.length === 0) return []
    const migrated = []
    const seen = new Set()
    for (const range of ranges) {
      for (const segment of this.#segments(session.id).filter((item) => item.state === 'working')) {
        if (seen.has(segment.id)) continue
        const overlaps = Number(segment.firstSeq) <= Number(range.end) && Number(segment.lastSeq) >= Number(range.start)
        if (!overlaps) continue
        const entries = this.#sensoryEntriesFor(segment)
        if (entries.length === 0) {
          migrated.push({ ok: false, transition: 'external-compaction', reason: 'no-indexable-evidence', segmentId: segment.id, range })
          continue
        }
        this.#persistSensoryEntries(entries)
        const lineage = {
          transition: 'external-compaction',
          purpose: 'sensory-checkpoint',
          start: range.start,
          end: range.end,
          replacementSeq: range.replacementSeq,
          compactionId: range.compactionId,
          fromRevision: Number(segment.surfaceRevision ?? 0),
          toRevision: Number(segment.surfaceRevision ?? 0) + 1,
          at: Date.now(),
        }
        this.#storeSegment({
          ...segment,
          state: 'sensory',
          surfaceRevision: lineage.toRevision,
          replacementLineage: [...(segment.replacementLineage ?? []), lineage],
          updatedAt: Date.now(),
        })
        seen.add(segment.id)
        this.stats.workingToSensory += 1
        this.stats.externalCompactionToSensory += 1
        migrated.push({ ok: true, transition: 'external-compaction', segmentId: segment.id, entryIds: entries.map((entry) => entry.id), lineage })
      }
    }
    return migrated
  }

  #syncReferences(sessionId, workspaceId) {
    const sync = this.semipersistentLayer.syncSessionReferences(sessionId, workspaceId)
    for (const projection of this.ledger.list('semipersistentProjections', { scopeKind: 'session', scopeId: sessionId })) {
      if (projection.state !== 'reference' || projection.workspaceId !== String(workspaceId)) continue
      const record = this.ledger.get('semipersistentRecords', projection.recordId, { scopeKind: 'workspace', scopeId: workspaceId })
      if (!record) continue
      const id = `semi-ref:${record.id}`
      if (this.ledger.get(SENSORY_LEDGER_COLLECTION, id, { scopeKind: 'session', scopeId: sessionId })) continue
      const entry = {
        id, kind: 'workspace-semi-ref', scopeKind: 'session', scopeId: String(sessionId), sessionId: String(sessionId), workspaceId: String(workspaceId),
        segmentId: record.id, title: record.title ?? record.id, aliases: [], canonicalFacts: record.canonicalFacts ?? [], episodeSummary: record.episodeSummary ?? '', approvedEpisode: true,
        sourceRefs: sourceRefs(record), evidenceQuality: record.evidenceQuality, verifiedSource: record.verifiedSource, associations: [], associationWeight: 0, createdAt: Date.now(), updatedAt: Date.now(),
      }
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, entry, { scopeKind: 'session', scopeId: sessionId, id })
    }
    return sync
  }

  #rootManifest(sessionId) {
    const entries = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId })
    if (!entries.length) return null
    let level = entries.sort((a, b) => Number(a.firstSeq ?? 0) - Number(b.firstSeq ?? 0)).map((entry) => ({
      firstSeq: entry.firstSeq ?? entry.sourceRefs?.[0]?.seq ?? 0,
      lastSeq: entry.lastSeq ?? entry.sourceRefs?.at?.(-1)?.seq ?? entry.sourceRefs?.[0]?.seq ?? 0,
      labels: [entry.title],
    }))
    const rows = [`（感知记忆根目录：${entries.length} 个 session-local 入口；目录曝光不计关联。）`]
    let depth = 0
    while (level.length > 1) {
      rows.push(`- level ${depth}: ${level.map((item) => `[${item.firstSeq}-${item.lastSeq}] ${item.labels.slice(0, 2).join(' / ')}`).join('；')}`)
      const next = []
      for (let index = 0; index < level.length; index += 4) {
        const group = level.slice(index, index + 4)
        next.push({ firstSeq: group[0].firstSeq, lastSeq: group.at(-1).lastSeq, labels: group.flatMap((item) => item.labels).slice(0, 2) })
      }
      if (next.length === level.length) break
      level = next
      depth += 1
    }
    rows.push('需要内容时使用 sensory_recall/sensory_open。')
    return rows.join('\n')
  }

  #expireSemipersistent(sessionId, workspaceId, currentWorkspaceTurn, now = Date.now()) {
    const expired = this.semipersistentLayer.expire({ sessionId, workspaceId, currentWorkspaceTurn, now })
    for (const item of expired) {
      if (item.state !== 'inactive') continue
      const record = this.ledger.get('semipersistentRecords', item.recordId, { scopeKind: 'workspace', scopeId: workspaceId })
      const segment = record?.segment ?? record
      if (!segment?.sessionId || String(segment.sessionId) !== String(sessionId)) continue
      const entries = this.#sensoryEntriesFor({ ...segment, state: 'sensory' })
      if (entries.length) this.#persistSensoryEntries(entries)
    }
    return expired
  }

  async preStep(payload, next) {
    const { agent, messages: claimed = [], turn = 0, step = 0, signal } = payload
    if (!agent?.session) return next()
    const headerArchived = agent.session.header?.archived === true || agent.session.archived === true
    if (headerArchived) {
      if (!this.frozenSessions.has(String(agent.session.id))) this.freezeSession(agent.session.id)
      return next()
    }
    if (this.frozenSessions.has(String(agent.session.id))) this.unfreezeSession(agent.session.id)
    this.stats.preSteps += 1
    signal?.throwIfAborted?.()
    const sessionId = String(agent.session.id)
    this.sessions.set(sessionId, agent.session)
    const workspace = await this.workspace(agent)
    const workspaceTurn = (this.workspaceTurns.get(workspace.workspaceId) ?? 0) + (step === 1 ? 1 : 0)
    this.workspaceTurns.set(workspace.workspaceId, workspaceTurn)
    const drain = await this.ledger.drain(`session:${sessionId}`, this.config.transitionWaitMs)
    if (drain.timeout) this.stats.transitionTimeouts += 1
    const model = await this.#resolveModelContext(signal)
    const derived = agent.session.deriveMessages?.() ?? []
    const priorBudget = this.surfaceProjector.budget({
      sessionId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      request: { messages: [...derived, ...claimed] },
    })
    const reconcile = this.surfaceProjector.reconcile(agent.session, this.#segments(sessionId))
    const externalTransitions = this.#reconcileExternalCompaction(agent.session, reconcile)
    const sync = this.#syncReferences(sessionId, workspace.workspaceId)
    const expired = this.#expireSemipersistent(sessionId, workspace.workspaceId, workspaceTurn)
    const transitions = [...externalTransitions, ...(drain.timeout ? [] : this.#processTransitions(agent.session, turn, priorBudget, model))]
    this.lastTransitions.set(sessionId, transitions)
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    const query = currentUserText([...derived, ...claimed])
    if (!query) return decision
    this.#recordBackReferences(query, { sessionId, workspaceId: workspace.workspaceId, turn })
    const taskState = { goal: agent.goal?.status ?? null, turn, step }
    const fast = this.matcher.retrieve(query, { sessionId, workspaceId: workspace.workspaceId, taskState, includeUserGlobal: this.config.userGlobalEnabled })
    let selected = fast.selected
    let slow = null
    if (!fast.sufficient) {
      const plannerCallsBefore = this.planner.stats.llmCalls
      slow = await this.planner.plan(fast, { sessionId, workspaceId: workspace.workspaceId, taskStateRevision: this.sessionState(sessionId).taskStateRevision, turn, step })
      this.#recordAuxiliary(sessionId, 'memory-retrieval-plan', this.planner.stats.llmCalls - plannerCallsBefore)
      if (slow?.verified) selected = slow.selected
    }
    const catalog = this.matcher.renderCatalog(selected)
    const semiBudget = Math.floor(priorBudget.usableInputTokens * this.surfaceProjector.config.semipersistentBudgetRatio)
    const renderedSemi = this.semipersistentLayer.renderSnapshot(sessionId, workspace.workspaceId, { budgetTokens: semiBudget })
    const semiPreparation = this.surfaceProjector.prepareSemipersistentSnapshot(agent.session, renderedSemi)
    const semi = semiPreparation.semi
    const rootManifest = (reconcile.restoreSensoryManifest || externalTransitions.some((item) => item.ok)) ? this.#rootManifest(sessionId) : null
    const rendered = this.surfaceProjector.renderMessages({ decision, claimed, sessionId, turn, step, semi, catalog, rootManifest })
    this.lastEvidence.set(sessionId, { query, fast, slow, selected, turn, step, workspaceId: workspace.workspaceId, at: Date.now() })
    this.setSessionState(sessionId, { workspaceId: workspace.workspaceId, workspaceResolution: workspace.resolution, lastTurn: turn, taskStateRevision: this.sessionState(sessionId).taskStateRevision + (step === 1 ? 1 : 0) })
    this.lastPreStep = { sessionId, workspace, drain, model, budget: priorBudget, reconcile: { ...reconcile, externalTransitions }, sync, expired, transitions, semiPreparation, fast: { topScore: fast.topScore, margin: fast.margin, sufficient: fast.sufficient, reasons: fast.slowPathReasons }, slow: slow?.plan ?? null, injected: rendered.inserted.map((item) => ({ purpose: item.purpose, index: item.index })) }
    return rendered.decision
  }

  turnStopping({ agent, turn }) {
    if (!agent?.session || this.frozenSessions.has(String(agent.session.id))) return null
    this.stats.turns += 1
    const sessionId = String(agent.session.id)
    this.sessions.set(sessionId, agent.session)
    return this.ledger.enqueue(`session:${sessionId}`, async () => {
      const workspace = await this.workspace(agent)
      let segment = this.segmenter.buildTurnSegment({ session: agent.session, turn, workspaceId: workspace.workspaceId, cwd: workspace.cwd })
      if (!segment) return { stored: false, reason: 'no-turn-events' }
      segment = this.#extractSegmentMetadata(segment)
      const lastEvidence = this.lastEvidence.get(sessionId)
      const assistantText = segment.records.filter((record) => record.role === 'assistant').map((record) => record.text).join('\n')
      for (const selected of lastEvidence?.selected ?? []) {
        const values = selected.canonicalFacts.map((fact) => String(fact.value ?? '')).filter(Boolean)
        if (!values.some((value) => assistantText.includes(value))) continue
        segment = addAssociation(segment, { sessionId, workspaceId: workspace.workspaceId, turn, kind: 'verified-answer-use', weight: 0.8, verified: true })
      }
      this.#storeSegment(segment)
      const directive = parseRememberDirective(segment.userText)
      let explicit = null
      if (directive) {
        const scopeId = directive.scopeKind === 'user-global' ? 'user-global' : workspace.workspaceId
        explicit = this.bank.put({ content: directive.content, scopeKind: directive.scopeKind, scopeId, sourceRefs: canonicalSourceRefs(segment, this.config.trustedEvidenceTools), sessionId, workspaceId: workspace.workspaceId, memoryType: segment.memoryType, explicit: true })
        if (explicit.stored) {
          segment = { ...segment, title: explicit.record.canonicalFacts[0]?.subject ?? segment.title, canonicalFacts: explicit.record.canonicalFacts, importance: 1, durability: 1, evidenceQuality: 1, verifiedSource: true, bankRecordId: explicit.record.id }
          this.#storeSegment(segment)
          this.semipersistentLayer.promote(segment, { workspaceId: workspace.workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspace.workspaceId) ?? turn })
          this.stats.explicitBankWrites += 1
        }
      } else if (this.transitionReviewer?.shouldReview(segment)) {
        const callsBefore = this.transitionReviewer.stats.llmCalls
        const review = await this.transitionReviewer.review(segment)
        this.#recordAuxiliary(sessionId, 'memory-transition-review', this.transitionReviewer.stats.llmCalls - callsBefore)
        segment = {
          ...segment,
          transitionReview: review,
          importance: Math.max(segment.importance, Number(review?.importance ?? 0)),
          durability: Math.max(segment.durability, Number(review?.durability ?? 0)),
          evidenceQuality: Math.min(segment.evidenceQuality, Number(review?.evidenceQuality ?? segment.evidenceQuality)),
          memoryType: review?.memoryType ?? segment.memoryType,
        }
        if (review?.action === 'bank' && review.content) {
          const scopeId = review.scopeKind === 'user-global' ? 'user-global' : workspace.workspaceId
          explicit = this.bank.put({ content: review.content, scopeKind: review.scopeKind, scopeId, sourceRefs: canonicalSourceRefs(segment, this.config.trustedEvidenceTools), sessionId, workspaceId: workspace.workspaceId, memoryType: review.memoryType, explicit: false })
          if (explicit.stored) {
            segment = { ...segment, title: explicit.record.canonicalFacts[0]?.subject ?? segment.title, canonicalFacts: explicit.record.canonicalFacts, bankRecordId: explicit.record.id, bankReviewApproved: true }
            this.semipersistentLayer.promote(segment, { workspaceId: workspace.workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspace.workspaceId) ?? turn })
          }
        }
        this.#storeSegment(segment)
      }
      this.ledger.flush()
      return { stored: true, segmentId: segment.id, explicit }
    })
  }

  recordOpen({ target, sessionId, workspaceId, turn, kind = 'sensory-open' }) {
    const sensory = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId }).find((entry) => entry.id === target || entry.title === target)
    if (sensory) {
      const updated = addAssociation(sensory, { sessionId, workspaceId, turn, kind, weight: 1, verified: true })
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, updated, { scopeKind: 'session', scopeId: sessionId, id: sensory.id })
      const segment = this.ledger.get(SEGMENTS, sensory.segmentId, { scopeKind: 'session', scopeId: sensory.sessionId })
      if (segment) {
        const associated = addAssociation(segment, { sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind, weight: 1, verified: true })
        this.#storeSegment(associated)
        if (this.policy.shouldPromoteToSemi(associated, { currentTurn: turn })) this.semipersistentLayer.promote(associated, { workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspaceId) ?? turn })
      }
      return { layer: 'sensory', record: updated }
    }
    const bank = this.bank.open(target, { workspaceId, sessionId, turn, weight: 1 })
    if (bank) return { layer: 'bank', record: bank }
    return null
  }

  async storeSensory(text, exec = {}) {
    const agent = exec?.agent
    if (!agent?.session?.id) throw new TypeError('current sessionId is required')
    const workspace = await this.workspace(agent)
    const latestSeq = [...(agent.session.events ?? [])].reverse().find((event) => Number.isFinite(event?.seq))?.seq ?? Date.now()
    let segment = {
      id: `manual-${agent.session.id}-${latestSeq}`,
      segmentId: `manual-${agent.session.id}-${latestSeq}`,
      sessionId: String(agent.session.id), workspaceId: workspace.workspaceId, cwd: workspace.cwd,
      turn: Number(exec.turn ?? this.sessionState(agent.session.id).lastTurn ?? 0), firstSeq: latestSeq, lastSeq: latestSeq, sourceSeqs: [latestSeq],
      records: [{ seq: latestSeq, time: Date.now(), eventType: 'user/message', role: 'user', sourceKind: 'user', text: String(text), message: { role: 'user', content: String(text) } }],
      userText: String(text), sealedAt: Date.now(), boundaryReason: 'explicit-sensory-store', openTask: false, pinned: false,
      importance: 0.7, durability: 0.7, evidenceQuality: 0.9, extractionConfidence: 0.6, verifiedSource: true,
      associations: [], surfaceRevision: 0, replacementLineage: [], state: 'sensory', createdAt: Date.now(), updatedAt: Date.now(),
    }
    segment = this.#extractSegmentMetadata(segment)
    this.#storeSegment(segment)
    const entries = this.#sensoryEntriesFor(segment)
    this.#persistSensoryEntries(entries)
    this.ledger.flush()
    return { stored: entries.length > 0, sessionId: segment.sessionId, workspaceId: workspace.workspaceId, segmentId: segment.id, entryIds: entries.map((entry) => entry.id), sourceRef: { sessionId: segment.sessionId, seq: latestSeq } }
  }

  async demoteBySeq(sourceSeq, exec = {}) {
    const agent = exec?.agent
    if (!agent?.session?.id) throw new TypeError('current sessionId is required')
    const segment = this.#segments(agent.session.id).find((item) => (item.sourceSeqs ?? []).map(String).includes(String(sourceSeq)))
    if (!segment) return { demoted: false, reason: 'source-not-tracked', sourceSeq }
    if (segment.state !== 'working') return { demoted: false, reason: 'already-transitioned', state: segment.state, segmentId: segment.id }
    const entries = this.#sensoryEntriesFor(segment)
    const text = this.surfaceProjector.sensoryCheckpoint(entries[0])
    const replaced = this.surfaceProjector.replaceSegment(agent.session, segment, { purpose: 'sensory-checkpoint', text, transition: 'manual-working-to-sensory' })
    if (!replaced.ok) return { demoted: false, ...replaced, segmentId: segment.id }
    this.#persistSensoryEntries(entries)
    this.#storeSegment({ ...segment, state: 'sensory', surfaceRevision: replaced.surfaceRevision, replacementLineage: [...(segment.replacementLineage ?? []), replaced.lineage], updatedAt: Date.now() })
    this.index.flush()
    return { demoted: true, segmentId: segment.id, sourceSeq, entryIds: entries.map((entry) => entry.id), lineage: replaced.lineage }
  }

  async finalizeSession(sessionId) {
    const drained = await this.ledger.drain(`session:${sessionId}`, 30_000)
    const session = this.sessions.get(String(sessionId))
    const transitions = []
    if (session) {
      for (const segment of this.#segments(sessionId).filter((item) => item.state === 'working')) {
        const result = this.#transitionWorking(session, segment, Number.MAX_SAFE_INTEGER, { pressureTriggered: true })
        if (result) transitions.push({ ...result, boundaryReason: 'benchmark-finalize' })
      }
      this.lastTransitions.set(String(sessionId), transitions)
    }
    this.ledger.flush()
    return { sessionId: String(sessionId), drained, transitions, layerCounts: this.layerCounts(sessionId) }
  }

  async drainSession(sessionId) {
    const drained = await this.ledger.drain(`session:${sessionId}`, 30_000)
    this.ledger.flush()
    this.index.flush()
    return { sessionId: String(sessionId), drained, layerCounts: this.layerCounts(sessionId) }
  }

  openBank(recordId, { sessionId, workspaceId, turn }) {
    const opened = this.bank.open(recordId, { workspaceId, sessionId, turn, weight: 1 })
    if (!opened) return null
    this.#materializeBankSelection({ id: opened.id, layer: 'bank', title: opened.canonicalFacts?.[0]?.subject ?? opened.id, raw: opened }, sessionId, workspaceId, turn)
    return opened
  }

  forget({ target, scope = 'workspace', sessionId, workspaceId }) {
    if (scope === 'session') {
      const entries = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId })
        .filter((entry) => entry.id === target || entry.title === target || String(entry.episodeSummary ?? '').includes(target))
      for (const entry of entries) {
        this.ledger.upsert(SENSORY_LEDGER_COLLECTION, { ...entry, tombstonedAt: Date.now(), updatedAt: Date.now() }, { scopeKind: 'session', scopeId: sessionId, id: entry.id })
        if (entry.legacyEntityId) this.index.removeEntity(entry.legacyEntityId)
      }
      this.index.flush()
      return { target, scope, tombstoned: entries.map((entry) => entry.id), rawEventsRetained: true }
    }
    const bankResult = this.bank.forget(target, { workspaceId, scope })
    const removedSemi = []
    for (const record of this.ledger.list('semipersistentRecords')) {
      if (!bankResult.tombstoned.includes(record.bankRecordId)) continue
      removedSemi.push(this.semipersistentLayer.removeRecord(record.id, record.workspaceId))
      for (const entry of this.ledger.list(SENSORY_LEDGER_COLLECTION)) {
        if (entry.segmentId !== record.id) continue
        this.ledger.delete(SENSORY_LEDGER_COLLECTION, entry.id, { scopeKind: 'session', scopeId: entry.sessionId })
        if (entry.legacyEntityId) this.index.removeEntity(entry.legacyEntityId)
      }
    }
    this.index.flush()
    return { ...bankResult, removedSemi, rawEventsRetained: true }
  }

  freezeSession(sessionId) { this.frozenSessions.add(String(sessionId)); this.setSessionState(sessionId, { archived: true }); return { sessionId: String(sessionId), frozen: true } }
  unfreezeSession(sessionId) { this.frozenSessions.delete(String(sessionId)); this.setSessionState(sessionId, { archived: false }); return { sessionId: String(sessionId), frozen: false } }

  clearSensory(sessionId) {
    const ledger = this.ledger.dropScope('session', String(sessionId), [SENSORY_LEDGER_COLLECTION])
    const index = this.index.clearScope(String(sessionId))
    return { sessionId: String(sessionId), ledger, index, deprecatedAlias: true }
  }

  async dropSession(sessionId, { workspaceId = null, dropUniqueWorkspaceMemory = false } = {}) {
    await this.finalizeSession(sessionId)
    const sensory = this.ledger.dropScope('session', String(sessionId), [SENSORY_LEDGER_COLLECTION, SEGMENTS, SESSION_STATE])
    const projections = this.semipersistentLayer.dropScope(sessionId)
    const index = this.index.dropScope(String(sessionId))
    const planner = this.planner.dropSession(sessionId)
    this.sessions.delete(String(sessionId))
    this.sessionAuxiliaryPurposes.delete(String(sessionId))
    let workspace = null
    if (dropUniqueWorkspaceMemory && workspaceId) {
      workspace = { semi: this.semipersistentLayer.dropWorkspace(workspaceId), bank: this.bank.dropWorkspace(workspaceId) }
    }
    return { sessionId: String(sessionId), scopeId: String(sessionId), sensory, projections, index, planner, workspace }
  }

  layerCounts(sessionId, workspaceId = this.sessionState(sessionId).workspaceId) {
    return {
      working: this.#segments(sessionId).filter((segment) => segment.state === 'working').length,
      sensory: this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId }).length,
      semipersistent: this.semipersistentLayer.status(sessionId, workspaceId),
      bank: this.bank.status(workspaceId),
    }
  }

  status(sessionId, workspaceId = this.sessionState(sessionId).workspaceId) {
    const auxiliaryPurposes = clone(this.sessionAuxiliaryPurposes.get(String(sessionId)) ?? {
      'memory-transition-review': 0,
      'memory-retrieval-plan': 0,
      'memory-audit': 0,
    })
    return {
      layeredV2: true,
      sessionId: String(sessionId),
      workspaceId,
      frozen: this.frozenSessions.has(String(sessionId)),
      layerCounts: this.layerCounts(sessionId, workspaceId),
      pending: this.ledger.status().pendingQueues,
      budget: this.surfaceProjector.status(sessionId).budget,
      transitions: clone(this.lastTransitions.get(String(sessionId)) ?? []),
      lastPreStep: clone(this.lastPreStep ?? null),
      matcher: this.matcher.status(),
      planner: this.planner.status(),
      transitionReviewer: this.transitionReviewer?.status?.() ?? null,
      stats: { ...clone(this.stats), auxiliaryPurposes, globalAuxiliaryPurposes: clone(this.stats.auxiliaryPurposes) },
    }
  }
}

export const LAYERED_RUNTIME_COLLECTIONS = { SEGMENTS, SESSION_STATE }
