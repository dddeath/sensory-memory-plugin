import { estimateTokens } from './context-utils.js'
import {
  canonicalSegmentSourceRefs as canonicalSourceRefs,
  cloneLayerValue as clone,
  currentUserText,
  enrichSegmentMetadata,
  normalizedWorkspaceFallback,
  segmentSourceRefs as sourceRefs,
  sensoryChunksForSegment,
} from './layered-memory-records.js'
import { addAssociation, parseRememberDirective } from './memory-policy.js'
import { lexicalTokens, SENSORY_LEDGER_COLLECTION } from './layered-match-engine.js'
import { cosineSimilarity } from './vector-encoder.js'

const SEGMENTS = 'sourceSegments'
const SESSION_STATE = 'sessionState'

export class LayeredMemoryRuntime {
  constructor({ ctx, config = {}, ledger, segmenter, policy, semipersistentLayer, bank, surfaceProjector, matcher, planner, transitionReviewer = null, chunker, vectorEncoder, debug = null, auxiliaryRequests = null }) {
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
    this.chunker = chunker
    this.vectorEncoder = vectorEncoder
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
      temporalSupersessions: 0,
      explicitBankWrites: 0,
      surfaceRevisionDrifts: 0,
      externalCompactionToSensory: 0,
      auxiliaryPurposes: { 'memory-transition-review': 0, 'memory-retrieval-plan': 0, 'memory-audit': 0 },
    }
  }

  // Session/workspace identity and persisted runtime state.
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

  // Pure record construction lives in layered-memory-records.js; this class
  // supplies runtime services and persists the result.
  async #extractSegmentMetadata(segment) {
    return enrichSegmentMetadata(segment, {
      chunker: this.chunker,
      vectorEncoder: this.vectorEncoder,
    })
  }

  #sensoryChunksFor(segment) {
    return sensoryChunksForSegment(segment, {
      chunker: this.chunker,
      vectorEncoder: this.vectorEncoder,
    })
  }

  #persistSensoryChunks(chunks) {
    const stored = []
    for (const chunk of chunks) {
      const superseded = this.#supersedePriorChunks(chunk)
      chunk.supersedes = superseded
      stored.push(this.ledger.upsert(SENSORY_LEDGER_COLLECTION, chunk, { scopeKind: 'session', scopeId: chunk.sessionId, id: chunk.id }))
    }
    return stored
  }

  #supersedePriorChunks(chunk) {
    if (!/(?:更新为|改为|变更为|现在(?:是|为)|当前.{0,24}(?:是|为)|updated?\s+to|changed?\s+to|now\s+is)/iu.test(chunk.coreText)) return []
    const newTokens = lexicalTokens(chunk.coreText)
    const superseded = []
    for (const prior of this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: chunk.sessionId })) {
      if (prior.id === chunk.id || prior.temporalCurrent === false || prior.supersededBy) continue
      const shared = [...newTokens].filter((token) => lexicalTokens(prior.coreText).has(token))
        .filter((token) => (/^[\u3400-\u9fff]+$/u.test(token) ? token.length >= 2 : token.length >= 3 && !/^\d+$/.test(token)))
      const similarity = chunk.vector && prior.vector
        ? cosineSimilarity(chunk.vector.values, prior.vector.values)
        : 0
      if (shared.length < 2 || similarity < 0.45 || String(prior.coreText) === String(chunk.coreText)) continue
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, {
        ...prior,
        temporalCurrent: false,
        supersededBy: chunk.id,
        supersededAt: Date.now(),
        updatedAt: Date.now(),
      }, { scopeKind: 'session', scopeId: prior.sessionId, id: prior.id })
      superseded.push(prior.id)
      this.stats.temporalSupersessions += 1
    }
    return superseded
  }

  readSource(sourceRef) {
    const sessionId = String(sourceRef?.sessionId ?? '')
    const seq = Number(sourceRef?.seq)
    if (!sessionId || !Number.isFinite(seq)) return null
    for (const segment of this.#segments(sessionId)) {
      const record = (segment.records ?? []).find((item) => Number(item.seq) === seq)
      if (record) return clone(record)
    }
    return null
  }

  // Model limits and association-driven layer transitions.
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
    // Passive lexical/vector retrieval is deliberately zero-association.
    // Strong associations are recorded only by sensory_open/bank_open or by a
    // verified final-answer use, so generic query words cannot promote chunks.
    return []
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
      label: candidate.label,
      turn,
      sourceSeqs: (record.sourceRefs ?? []).map((ref) => ref.seq),
      records: [{ seq: (record.sourceRefs ?? [])[0]?.seq ?? 0, role: 'user', text: record.coreText, blockKinds: ['text'], sourceKind: 'bank' }],
      contextChunks: [{ ...record, segmentId: `bank-materialized:${record.id}` }],
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
    const chunks = this.#sensoryChunksFor(segment)
    if (chunks.length === 0) return { ok: false, reason: 'no-indexable-context', segmentId: segment.id }
    const text = this.surfaceProjector.sensoryCheckpoint(chunks[0])
    const replaced = this.surfaceProjector.replaceSegment(session, segment, { purpose: 'sensory-checkpoint', text, transition: budget?.pressureTriggered ? 'context-pressure' : 'working-to-sensory' })
    if (!replaced.ok) { if (replaced.reason === 'surface-revision-drift') this.stats.surfaceRevisionDrifts += 1; return replaced }
    this.#persistSensoryChunks(chunks)
    const updated = { ...segment, state: 'sensory', surfaceRevision: replaced.surfaceRevision, replacementLineage: [...(segment.replacementLineage ?? []), replaced.lineage], updatedAt: Date.now() }
    this.#storeSegment(updated)
    this.stats.workingToSensory += 1
    return { ok: true, transition: 'working-to-sensory', segmentId: segment.id, chunkIds: chunks.map((chunk) => chunk.id), lineage: replaced.lineage }
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
        const chunks = this.#sensoryChunksFor(segment)
        if (chunks.length === 0) {
          migrated.push({ ok: false, transition: 'external-compaction', reason: 'no-indexable-context', segmentId: segment.id, range })
          continue
        }
        this.#persistSensoryChunks(chunks)
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
        migrated.push({ ok: true, transition: 'external-compaction', segmentId: segment.id, chunkIds: chunks.map((chunk) => chunk.id), lineage })
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
      const sourceChunks = record.contextChunks ?? record.segment?.contextChunks ?? []
      const text = sourceChunks.map((chunk) => chunk.coreText).join('\n')
        || (record.records ?? []).map((item) => `${item.role}: ${item.text ?? ''}`).join('\n')
      const chunk = {
        id, kind: 'context-chunk', referenceKind: 'workspace-semipersistent', scopeKind: 'session', scopeId: String(sessionId), sessionId: String(sessionId), workspaceId: String(workspaceId),
        segmentId: record.id, label: record.label ?? `workspace context ${record.id}`, coreText: text, contextText: text,
        vector: sourceChunks[0]?.vector ?? null, vectorKey: sourceChunks[0]?.vectorKey ?? null,
        sourceRefs: sourceRefs(record), evidenceSourceRefs: sourceRefs(record), evidenceQuality: record.evidenceQuality, verifiedSource: record.verifiedSource,
        temporalCurrent: true, supersededBy: null, associations: [], associationWeight: 0, createdAt: Date.now(), updatedAt: Date.now(),
      }
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, chunk, { scopeKind: 'session', scopeId: sessionId, id })
    }
    return sync
  }

  #rootManifest(sessionId) {
    const entries = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId })
    if (!entries.length) return null
    let level = entries.sort((a, b) => Number(a.firstSeq ?? 0) - Number(b.firstSeq ?? 0)).map((entry) => ({
      firstSeq: entry.firstSeq ?? entry.sourceRefs?.[0]?.seq ?? 0,
      lastSeq: entry.lastSeq ?? entry.sourceRefs?.at?.(-1)?.seq ?? entry.sourceRefs?.[0]?.seq ?? 0,
      labels: [entry.label ?? entry.id],
    }))
    const rows = [`（卸载上下文根目录：${entries.length} 个 session-local chunk；目录曝光不计关联。）`]
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
      const chunks = this.#sensoryChunksFor({ ...segment, state: 'sensory' })
      if (chunks.length) this.#persistSensoryChunks(chunks)
    }
    return expired
  }

  // DSH lifecycle: pre-step prepares the model surface; turn-stopping records
  // the completed transaction without delaying the already-finished reply.
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
    const fast = await this.matcher.retrieveAsync(query, { sessionId, workspaceId: workspace.workspaceId, taskState, includeUserGlobal: this.config.userGlobalEnabled })
    let selected = fast.selected
    let slow = null
    if (fast.needsPlanner) {
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
    const slowStatus = slow ? {
      ...slow.plan,
      verified: Boolean(slow.verified),
      verificationMargin: slow.margin ?? 0,
      resolvedQuery: slow.resolvedQuery ?? slow.plan?.resolvedQuery ?? '',
      verifiedSelected: (slow.selected ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        lexicalRelevance: item.lexicalRelevance,
        vectorRelevance: item.vectorRelevance,
        effectiveRelevance: item.effectiveRelevance,
        sourceValidation: item.sourceValidation,
      })),
    } : null
    this.lastPreStep = { sessionId, workspace, drain, model, budget: priorBudget, reconcile: { ...reconcile, externalTransitions }, sync, expired, transitions, semiPreparation, fast: { topScore: fast.topScore, margin: fast.margin, sufficient: fast.sufficient, reasons: fast.slowPathReasons }, slow: slowStatus, injected: rendered.inserted.map((item) => ({ purpose: item.purpose, index: item.index })) }
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
      segment = await this.#extractSegmentMetadata(segment)
      const lastEvidence = this.lastEvidence.get(sessionId)
      const assistantText = segment.records.filter((record) => record.role === 'assistant').map((record) => record.text).join('\n')
      for (const selected of lastEvidence?.selected ?? []) {
        const matched = (selected.matchedTokens ?? []).filter((value) => String(value).length >= 2)
        if (!matched.some((value) => assistantText.toLowerCase().includes(String(value).toLowerCase()))) continue
        segment = addAssociation(segment, { sessionId, workspaceId: workspace.workspaceId, turn, kind: 'verified-answer-use', weight: 0.8, verified: true })
      }
      this.#storeSegment(segment)
      const directive = parseRememberDirective(segment.userText)
      let explicit = null
      if (directive) {
        const scopeId = directive.scopeKind === 'user-global' ? 'user-global' : workspace.workspaceId
        explicit = await this.bank.putAsync({ content: directive.content, scopeKind: directive.scopeKind, scopeId, sourceRefs: canonicalSourceRefs(segment, this.config.trustedEvidenceTools), sessionId, workspaceId: workspace.workspaceId, memoryType: segment.memoryType, explicit: true })
        if (explicit.stored) {
          segment = { ...segment, label: explicit.record.label ?? segment.label, importance: 1, durability: 1, evidenceQuality: 1, verifiedSource: true, bankRecordId: explicit.record.id }
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
          explicit = await this.bank.putAsync({ content: review.content, scopeKind: review.scopeKind, scopeId, sourceRefs: canonicalSourceRefs(segment, this.config.trustedEvidenceTools), sessionId, workspaceId: workspace.workspaceId, memoryType: review.memoryType, explicit: false })
          if (explicit.stored) {
            segment = { ...segment, label: explicit.record.label ?? segment.label, bankRecordId: explicit.record.id, bankReviewApproved: true }
            this.semipersistentLayer.promote(segment, { workspaceId: workspace.workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspace.workspaceId) ?? turn })
          }
        }
        this.#storeSegment(segment)
      }
      this.ledger.flush()
      return { stored: true, segmentId: segment.id, explicit }
    })
  }

  // Tool and maintenance API. Storage, policy and projection details stay in
  // the composed services rather than leaking into tool definitions.
  recordOpen({ target, sessionId, workspaceId, turn, kind = 'sensory-open' }) {
    const sensory = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId }).find((chunk) => chunk.id === target || chunk.label === target)
    if (sensory) {
      const updated = addAssociation(sensory, { sessionId, workspaceId, turn, kind, weight: 1, verified: true })
      this.ledger.upsert(SENSORY_LEDGER_COLLECTION, updated, { scopeKind: 'session', scopeId: sessionId, id: sensory.id })
      const segment = this.ledger.get(SEGMENTS, sensory.segmentId, { scopeKind: 'session', scopeId: sensory.sessionId })
      if (segment) {
        const associated = addAssociation(segment, { sessionId, workspaceId, turn, workspaceTurn: this.workspaceTurns.get(workspaceId), kind, weight: 1, verified: true })
        this.#storeSegment(associated)
        if (this.policy.shouldPromoteToSemi(associated, { currentTurn: turn })) this.semipersistentLayer.promote(associated, { workspaceId, sessionId, workspaceTurn: this.workspaceTurns.get(workspaceId) ?? turn })
      }
      return { layer: 'sensory', chunk: updated }
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
      records: [{ seq: latestSeq, time: Date.now(), eventType: 'assistant/tool-memory', role: 'assistant', sourceKind: 'plugin-tool', text: String(text), message: { role: 'assistant', content: String(text), source: { kind: 'plugin', purpose: 'sensory-store' } } }],
      userText: String(text), sealedAt: Date.now(), boundaryReason: 'explicit-sensory-store', openTask: false, pinned: false,
      importance: 0.7, durability: 0.7, evidenceQuality: 0.85, extractionConfidence: 0, verifiedSource: true,
      associations: [], surfaceRevision: 0, replacementLineage: [], state: 'sensory', createdAt: Date.now(), updatedAt: Date.now(),
    }
    segment = await this.#extractSegmentMetadata(segment)
    this.#storeSegment(segment)
    const chunks = this.#sensoryChunksFor(segment)
    this.#persistSensoryChunks(chunks)
    this.ledger.flush()
    return { stored: chunks.length > 0, architecture: 'chunk-only-vector', sessionId: segment.sessionId, workspaceId: workspace.workspaceId, segmentId: segment.id, chunkIds: chunks.map((chunk) => chunk.id), sourceRef: { sessionId: segment.sessionId, seq: latestSeq } }
  }

  async demoteBySeq(sourceSeq, exec = {}) {
    const agent = exec?.agent
    if (!agent?.session?.id) throw new TypeError('current sessionId is required')
    const segment = this.#segments(agent.session.id).find((item) => (item.sourceSeqs ?? []).map(String).includes(String(sourceSeq)))
    if (!segment) return { demoted: false, reason: 'source-not-tracked', sourceSeq }
    if (segment.state !== 'working') return { demoted: false, reason: 'already-transitioned', state: segment.state, segmentId: segment.id }
    const chunks = this.#sensoryChunksFor(segment)
    const text = this.surfaceProjector.sensoryCheckpoint(chunks[0])
    const replaced = this.surfaceProjector.replaceSegment(agent.session, segment, { purpose: 'sensory-checkpoint', text, transition: 'manual-working-to-sensory' })
    if (!replaced.ok) return { demoted: false, ...replaced, segmentId: segment.id }
    this.#persistSensoryChunks(chunks)
    this.#storeSegment({ ...segment, state: 'sensory', surfaceRevision: replaced.surfaceRevision, replacementLineage: [...(segment.replacementLineage ?? []), replaced.lineage], updatedAt: Date.now() })
    return { demoted: true, segmentId: segment.id, sourceSeq, chunkIds: chunks.map((chunk) => chunk.id), lineage: replaced.lineage }
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
    return { sessionId: String(sessionId), drained, layerCounts: this.layerCounts(sessionId) }
  }

  openBank(recordId, { sessionId, workspaceId, turn }) {
    const opened = this.bank.open(recordId, { workspaceId, sessionId, turn, weight: 1 })
    if (!opened) return null
    this.#materializeBankSelection({ id: opened.id, layer: 'bank', label: opened.label ?? opened.id, raw: opened }, sessionId, workspaceId, turn)
    return opened
  }

  forget({ target, scope = 'workspace', sessionId, workspaceId }) {
    if (scope === 'session') {
      const chunks = this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId })
        .filter((chunk) => chunk.id === target || chunk.label === target || String(chunk.coreText ?? '').includes(target))
      for (const chunk of chunks) {
        this.ledger.upsert(SENSORY_LEDGER_COLLECTION, { ...chunk, tombstonedAt: Date.now(), updatedAt: Date.now() }, { scopeKind: 'session', scopeId: sessionId, id: chunk.id })
      }
      return { target, scope, tombstoned: chunks.map((chunk) => chunk.id), rawEventsRetained: true }
    }
    const bankResult = this.bank.forget(target, { workspaceId, scope })
    const removedSemi = []
    for (const record of this.ledger.list('semipersistentRecords')) {
      if (!bankResult.tombstoned.includes(record.bankRecordId)) continue
      removedSemi.push(this.semipersistentLayer.removeRecord(record.id, record.workspaceId))
      for (const chunk of this.ledger.list(SENSORY_LEDGER_COLLECTION)) {
        if (chunk.segmentId !== record.id) continue
        this.ledger.delete(SENSORY_LEDGER_COLLECTION, chunk.id, { scopeKind: 'session', scopeId: chunk.sessionId })
      }
    }
    return { ...bankResult, removedSemi, rawEventsRetained: true }
  }

  freezeSession(sessionId) { this.frozenSessions.add(String(sessionId)); this.setSessionState(sessionId, { archived: true }); return { sessionId: String(sessionId), frozen: true } }
  unfreezeSession(sessionId) { this.frozenSessions.delete(String(sessionId)); this.setSessionState(sessionId, { archived: false }); return { sessionId: String(sessionId), frozen: false } }

  clearSensory(sessionId) {
    const ledger = this.ledger.dropScope('session', String(sessionId), [SENSORY_LEDGER_COLLECTION])
    return { sessionId: String(sessionId), ledger, deprecatedAlias: true }
  }

  async dropSession(sessionId, { workspaceId = null, dropUniqueWorkspaceMemory = false } = {}) {
    await this.finalizeSession(sessionId)
    const sensory = this.ledger.dropScope('session', String(sessionId), [SENSORY_LEDGER_COLLECTION, SEGMENTS, SESSION_STATE])
    const projections = this.semipersistentLayer.dropScope(sessionId)
    const planner = this.planner.dropSession(sessionId)
    this.sessions.delete(String(sessionId))
    this.sessionAuxiliaryPurposes.delete(String(sessionId))
    let workspace = null
    if (dropUniqueWorkspaceMemory && workspaceId) {
      workspace = { semi: this.semipersistentLayer.dropWorkspace(workspaceId), bank: this.bank.dropWorkspace(workspaceId) }
    }
    return { sessionId: String(sessionId), scopeId: String(sessionId), sensory, projections, planner, workspace }
  }

  layerCounts(sessionId, workspaceId = this.sessionState(sessionId).workspaceId) {
    return {
      working: this.#segments(sessionId).filter((segment) => segment.state === 'working').length,
      sensoryChunks: this.ledger.list(SENSORY_LEDGER_COLLECTION, { scopeKind: 'session', scopeId: sessionId }).length,
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
      architecture: 'chunk-only-vector',
      sessionId: String(sessionId),
      workspaceId,
      frozen: this.frozenSessions.has(String(sessionId)),
      layerCounts: this.layerCounts(sessionId, workspaceId),
      pending: this.ledger.status().pendingQueues,
      budget: this.surfaceProjector.status(sessionId).budget,
      transitions: clone(this.lastTransitions.get(String(sessionId)) ?? []),
      lastPreStep: clone(this.lastPreStep ?? null),
      matcher: this.matcher.status(),
      chunker: this.chunker?.status?.() ?? null,
      vectorEncoder: this.vectorEncoder?.status?.() ?? null,
      planner: this.planner.status(),
      transitionReviewer: this.transitionReviewer?.status?.() ?? null,
      stats: { ...clone(this.stats), auxiliaryPurposes, globalAuxiliaryPurposes: clone(this.stats.auxiliaryPurposes) },
    }
  }
}

export const LAYERED_RUNTIME_COLLECTIONS = { SEGMENTS, SESSION_STATE }
