import { join } from 'node:path'

import { estimateTokens } from './context-utils.js'
import { ContextChunker } from './context-chunker.js'
import { LayeredMatchEngine } from './layered-match-engine.js'
import { LayeredMemoryRuntime } from './layered-memory-runtime.js'
import { MemoryBank } from './memory-bank.js'
import { MemoryLedger } from './memory-ledger.js'
import { MemoryPolicy } from './memory-policy.js'
import { MemoryRetrievalPlanner } from './memory-retrieval-planner.js'
import { MemorySegmenter } from './memory-segmenter.js'
import { MemorySurfaceProjector } from './memory-surface-projector.js'
import { SemipersistentLayer } from './semipersistent-layer.js'
import { FeatureHashVectorEncoder } from './vector-encoder.js'

function eventMessage(event) {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'assistant/message') return event.data?.message ?? event.data
  if (event?.type === 'tool/result') return event.data
  return null
}

function clipToTokens(text, limit) {
  const input = String(text ?? '')
  const budget = Math.max(0, Number(limit) || 0)
  if (estimateTokens(input) <= budget) return input
  let low = 0
  let high = input.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(input.slice(0, middle)) <= budget) low = middle
    else high = middle - 1
  }
  return input.slice(0, low)
}

export function createStandaloneSession({ id, cwd }) {
  const events = []
  const replacements = []
  return {
    id: String(id),
    header: { cwd },
    events,
    replacements,
    append(type, data, options = {}) {
      const event = {
        seq: Math.max(0, ...events.map((item) => Number(item.seq) || 0)) + 1,
        time: Date.now(),
        type,
        data,
        ...options,
      }
      events.push(event)
      if (options?.surfaceOp?.op === 'replace') replacements.push(event)
      return event
    },
    deriveMessages() {
      const visible = new Map()
      for (const event of events) {
        const operation = event.surfaceOp
        if (operation?.op === 'replace') {
          for (const seq of [...visible.keys()]) {
            if (seq >= Number(operation.start) && seq <= Number(operation.end)) visible.delete(seq)
          }
        }
        const message = eventMessage(event)
        if (message) visible.set(Number(event.seq), message)
      }
      return [...visible.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])
    },
  }
}

function evidenceText(selected, budgetTokens) {
  const rows = []
  let used = 0
  for (const item of selected ?? []) {
    const header = `[[chunk:${item.id}]] [${item.layer}] [sourceRefs:${(item.sourceRefs ?? []).map((ref) => ref.seq).join(',')}]\n`
    const available = Math.max(0, Number(budgetTokens) - used - estimateTokens(header))
    if (available <= 0) break
    const body = clipToTokens(item.coreText, available)
    const row = `${header}${body}`
    const tokens = estimateTokens(row)
    if (!body || used + tokens > budgetTokens) break
    rows.push(row)
    used += tokens
  }
  return { text: rows.join('\n\n'), tokens: used }
}

export class StandaloneChunkMemory {
  constructor({ rootDir, sessionId, workspaceId = 'memgym-dr', cwd = 'E:/memgym', maxTokens = 32_768, config = {} }) {
    if (!rootDir) throw new TypeError('rootDir is required')
    if (!sessionId) throw new TypeError('sessionId is required')
    this.rootDir = String(rootDir)
    this.sessionId = String(sessionId)
    this.workspaceId = String(workspaceId)
    this.cwd = String(cwd)
    this.maxTokens = Math.max(512, Number(maxTokens) || 32_768)
    this.config = {
      indexScope: 'session',
      userGlobalEnabled: false,
      vectorDimensions: 384,
      contextWindow: this.maxTokens + 512,
      defaultContextWindow: this.maxTokens + 512,
      maxOutputTokens: 512,
      transitionWaitMs: 5_000,
      ...config,
    }

    this.ledger = new MemoryLedger(join(this.rootDir, 'chunk-memory-v1'), this.config)
    this.policy = new MemoryPolicy(this.config)
    this.chunker = new ContextChunker(this.config)
    this.vectorEncoder = new FeatureHashVectorEncoder({ dimensions: this.config.vectorDimensions })
    this.semipersistentLayer = new SemipersistentLayer({ ledger: this.ledger, policy: this.policy, config: this.config })
    this.bank = new MemoryBank({
      ledger: this.ledger,
      semipersistentLayer: this.semipersistentLayer,
      chunker: this.chunker,
      vectorEncoder: this.vectorEncoder,
      config: this.config,
    })
    this.surfaceProjector = new MemorySurfaceProjector({ ledger: this.ledger, config: this.config })
    const sourceReader = (sourceRef) => {
      for (const segment of this.ledger.list('sourceSegments', { scopeKind: 'session', scopeId: sourceRef?.sessionId })) {
        const record = (segment.records ?? []).find((item) => Number(item.seq) === Number(sourceRef?.seq))
        if (record) return record
      }
      return null
    }
    this.matcher = new LayeredMatchEngine({
      ledger: this.ledger,
      bank: this.bank,
      vectorEncoder: this.vectorEncoder,
      sourceReader,
      config: this.config,
    })
    this.planner = new MemoryRetrievalPlanner({ matcher: this.matcher, llm: null, config: this.config })
    const ctx = {
      workspaceRegistry: { resolveByPath: async () => ({ id: this.workspaceId }) },
      logger: { warn() {} },
      llm: null,
    }
    this.runtime = new LayeredMemoryRuntime({
      ctx,
      config: this.config,
      ledger: this.ledger,
      segmenter: new MemorySegmenter(this.config),
      policy: this.policy,
      semipersistentLayer: this.semipersistentLayer,
      bank: this.bank,
      surfaceProjector: this.surfaceProjector,
      matcher: this.matcher,
      planner: this.planner,
      chunker: this.chunker,
      vectorEncoder: this.vectorEncoder,
    })
    this.session = createStandaloneSession({ id: this.sessionId, cwd: this.cwd })
    this.agent = { cwd: this.cwd, session: this.session }
    this.turn = 0
    this.observations = []
    this.lastNotes = ''
    this.lastManage = null
    this.closed = false
  }

  #assertOpen() {
    if (this.closed) throw new Error('standalone chunk memory is closed')
  }

  async #finalizePriorTurn() {
    if (this.turn === 0) return { transitions: [], layerCounts: this.runtime.layerCounts(this.sessionId, this.workspaceId) }
    return this.runtime.finalizeSession(this.sessionId)
  }

  async #appendTurn(text) {
    const turn = this.turn + 1
    this.session.append('turn/start', { turn })
    this.session.append('user/message', {
      id: `memgym-${this.sessionId}-${turn}`,
      role: 'user',
      turn,
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user', purpose: 'memgym-observation' },
    })
    this.session.append('turn/end', { turn })
    const pending = this.runtime.turnStopping({ agent: this.agent, turn })
    await pending
    await this.ledger.drain(`session:${this.sessionId}`, this.config.transitionWaitMs)
    this.turn = turn
  }

  async #match(query) {
    return this.matcher.retrieveAsync(String(query ?? ''), {
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      includeUserGlobal: false,
      taskState: { turn: this.turn, source: 'memgym' },
    })
  }

  async manageContext({ originalContext = [], currentObservation, metadata = {} }) {
    this.#assertOpen()
    const observation = String(currentObservation ?? '')
    const finalized = await this.#finalizePriorTurn()
    await this.#appendTurn(observation)
    this.observations.push(observation)
    const query = String(metadata.question ?? metadata.query ?? observation)
    const match = await this.#match(query)
    const visibleObservation = clipToTokens(observation, this.maxTokens)
    const memoryBudget = Math.max(0, this.maxTokens - estimateTokens(visibleObservation) - 32)
    const evidence = evidenceText(match.selected, memoryBudget)
    const content = [evidence.text, visibleObservation].filter(Boolean)
    const tokens = estimateTokens(content.join('\n\n'))
    const originalTokens = estimateTokens(this.observations.join('\n\n'))
    this.lastNotes = evidence.text
    this.lastManage = {
      content,
      metadata: {
        tokens,
        original_tokens: originalTokens,
        was_compacted: finalized.transitions.length > 0 || originalTokens > this.maxTokens,
        compression_ratio: originalTokens > 0 ? tokens / originalTokens : 1,
        strategy: 'ir_dsh_chunk',
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        turn: this.turn,
        query,
        retrievedChunkIds: match.selected.map((item) => item.id),
        sourceRefs: match.selected.flatMap((item) => item.sourceRefs ?? []),
        needsPlanner: match.needsPlanner,
        plannerCalls: 0,
        plannerDeferred: match.needsPlanner,
        transitionCount: finalized.transitions.length,
        layerCounts: this.runtime.layerCounts(this.sessionId, this.workspaceId),
        memoryTokens: evidence.tokens,
        maxTokens: this.maxTokens,
        suppliedOriginalContextItems: Array.isArray(originalContext) ? originalContext.length : 0,
      },
    }
    return this.lastManage
  }

  async retrieve(query, { budgetTokens = this.maxTokens } = {}) {
    this.#assertOpen()
    const match = await this.#match(query)
    const evidence = evidenceText(match.selected, Math.max(0, Number(budgetTokens) || 0))
    this.lastNotes = evidence.text
    return {
      query: String(query),
      notes: evidence.text,
      estimatedTokens: evidence.tokens,
      selected: match.selected.map((item) => ({
        id: item.id,
        label: item.label,
        layer: item.layer,
        coreText: item.coreText,
        sourceRefs: item.sourceRefs,
        effectiveRelevance: item.effectiveRelevance,
        sourceValidation: item.sourceValidation,
      })),
      needsPlanner: match.needsPlanner,
      slowPathReasons: match.slowPathReasons,
      plannerCalls: 0,
      plannerDeferred: match.needsPlanner,
    }
  }

  stats() {
    this.#assertOpen()
    const sensoryChunks = this.ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: this.sessionId })
      .map((chunk) => ({
        id: chunk.id,
        segmentId: chunk.segmentId,
        coreText: chunk.coreText,
        sourceRefs: chunk.sourceRefs,
        temporalCurrent: chunk.temporalCurrent !== false,
        supersededBy: chunk.supersededBy ?? null,
        vector: chunk.vector ? { provider: chunk.vector.provider, model: chunk.vector.model, dimensions: chunk.vector.dimensions } : null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    return {
      architecture: 'chunk-only-vector',
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      turn: this.turn,
      observations: this.observations.length,
      layerCounts: this.runtime.layerCounts(this.sessionId, this.workspaceId),
      runtime: this.runtime.status(this.sessionId, this.workspaceId),
      matcher: this.matcher.status(),
      vectorEncoder: this.vectorEncoder.status(),
      eventCount: this.session.events.length,
      replacementCount: this.session.replacements.length,
      sensoryChunks,
      lastManage: this.lastManage?.metadata ?? null,
    }
  }

  close() {
    if (this.closed) return { closed: true, alreadyClosed: true }
    this.ledger.flush()
    this.closed = true
    return { closed: true, sessionId: this.sessionId, layerCounts: this.runtime.layerCounts(this.sessionId, this.workspaceId) }
  }
}
