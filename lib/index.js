import { join, resolve } from 'node:path'

import { DemotionEngine, IndexSourceStore, messageTextOf } from './demotion-engine.js'
import { ExtractionEngine } from './extraction-engine.js'
import { FallbackRewriter } from './fallback-rewriter.js'
import { HaluMemAuditor } from './halu-mem-auditor.js'
import { extractQuery, InjectionEngine } from './injection-engine.js'
import { installLayeredV2 } from './install-layered-v2.js'
import { LayeredMatchEngine } from './layered-match-engine.js'
import { LayeredMemoryRuntime } from './layered-memory-runtime.js'
import { LLMExtractor } from './llm-extractor.js'
import { MatchEngine } from './match-engine.js'
import { MemoryBank } from './memory-bank.js'
import { MemoryLedger } from './memory-ledger.js'
import { MemoryPolicy } from './memory-policy.js'
import { MemoryRetrievalPlanner } from './memory-retrieval-planner.js'
import { MemorySegmenter } from './memory-segmenter.js'
import { MemorySurfaceProjector } from './memory-surface-projector.js'
import { MemoryTransitionReviewer } from './memory-transition-reviewer.js'
import { SemipersistentCache } from './semipersistent-cache.js'
import { SemipersistentLayer } from './semipersistent-layer.js'
import { SensoryDebugService } from './sensory-debug.js'
import { SensoryIndex } from './sensory-index.js'
import { SensoryMaintenance } from './sensory-maintenance.js'
import { Stage4LlmClient } from './stage4-llm.js'

export const name = 'sensory-memory'
export const inject = ['systemPrompt', 'tools', 'llm', 'workspaceRegistry', 'tokenMeter']

function defaultIndexDir() {
  return resolve(process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh'), 'sensory-index')
}

function messageSeqMap(session) {
  const result = new Map()
  for (const event of session?.events ?? []) {
    const message = event?.type === 'user/message' ? event.data : event?.data?.message
    if (message?.id !== undefined && Number.isFinite(event?.seq)) result.set(String(message.id), event.seq)
  }
  return result
}

function sourceSeqOf(message, turn, messageIndex, seqMap) {
  const base = message?.sourceSeq
    ?? message?.seq
    ?? (message?.id === undefined ? undefined : seqMap?.get(String(message.id)))
    ?? message?.id
    ?? message?.source?.seq
    ?? `${turn}-${messageIndex}`
  return base
}

export function extractRecentTurnMessages(messages, turn, session = null) {
  if (!Array.isArray(messages) || messages.length === 0) return []
  const seqMap = messageSeqMap(session)
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index]?.source?.kind === 'user') {
      start = index
      break
    }
  }
  const result = []
  for (let messageIndex = start; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    if (!message) continue
    if (message.source?.kind === 'plugin') continue
    const role = String(message.role ?? 'assistant')
    const base = {
      role,
      sourceSeq: sourceSeqOf(message, turn, messageIndex, seqMap),
      toolName: message.toolName ?? message.name,
    }
    if (role === 'tool' || message.source?.kind === 'tool') {
      const text = messageTextOf(message)
      if (text.trim()) result.push({ ...base, role: 'tool', kind: 'tool', text })
      continue
    }
    if (Array.isArray(message.content)) {
      message.content.forEach((block, blockIndex) => {
        if (!block || typeof block !== 'object') return
        if (block.type !== 'text' && block.type !== 'reasoning') return
        if (typeof block.text !== 'string' || !block.text.trim()) return
        result.push({
          ...base,
          sourceSeq: sourceSeqOf(message, turn, messageIndex, seqMap),
          blockIndex,
          kind: block.type === 'reasoning' ? 'reasoning' : 'message',
          text: block.text,
        })
      })
      continue
    }
    const text = messageTextOf(message)
    if (text.trim()) result.push({ ...base, kind: 'message', text })
  }
  return result
}

export function lastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].text ?? '')
  }
  return ''
}

export function apply(ctx, config = {}) {
  const effectiveConfig = { ...config, indexScope: 'session' }
  const index = new SensoryIndex(config.indexDir || defaultIndexDir(), { ...effectiveConfig, legacyMirror: false })
  const extractor = new ExtractionEngine()
  const legacyMatcher = new MatchEngine(index, effectiveConfig)
  const sourceStore = new IndexSourceStore(index)
  const demoter = new DemotionEngine({ index, extractor, sourceStore, matcher: legacyMatcher, config: effectiveConfig })
  const injector = new InjectionEngine({ matcher: legacyMatcher, config: effectiveConfig })
  const auxiliaryRequests = new WeakSet()
  const llmClient = new Stage4LlmClient({ llm: ctx.llm, config: effectiveConfig, auxiliaryRequests })
  const llmExtractor = new LLMExtractor({ llm: llmClient, index, config: effectiveConfig })
  const auditor = new HaluMemAuditor({ index, llm: llmClient, config: effectiveConfig })
  const rewriter = new FallbackRewriter({ matcher: legacyMatcher, llm: llmClient, config: { ...effectiveConfig, rewriterEnabled: false } })
  const ledger = new MemoryLedger(join(index.indexDir, 'layered-v2'), effectiveConfig)
  const segmenter = new MemorySegmenter(effectiveConfig)
  const policy = new MemoryPolicy(effectiveConfig)
  const semipersistentLayer = new SemipersistentLayer({ ledger, policy, config: effectiveConfig })
  const bank = new MemoryBank({ ledger, semipersistentLayer, config: effectiveConfig })
  const surfaceProjector = new MemorySurfaceProjector({ ledger, tokenMeter: ctx.tokenMeter, config: effectiveConfig })
  const matcher = new LayeredMatchEngine({ ledger, bank, config: effectiveConfig })
  const planner = new MemoryRetrievalPlanner({ matcher, llm: llmClient, config: effectiveConfig })
  const transitionReviewer = new MemoryTransitionReviewer({ llm: llmClient, config: effectiveConfig })
  const runtime = new LayeredMemoryRuntime({
    ctx,
    config: { ...effectiveConfig, llmProvider: config.llmProvider, llmModel: config.llmModel },
    ledger,
    segmenter,
    policy,
    semipersistentLayer,
    bank,
    surfaceProjector,
    matcher,
    planner,
    transitionReviewer,
    index,
    extractor,
    sourceStore,
    auxiliaryRequests,
  })
  const cache = semipersistentLayer
  const maintenance = new SensoryMaintenance({ index, demoter, matcher: legacyMatcher, llmExtractor, cache, rewriter, runtime, config: effectiveConfig })
  const debug = new SensoryDebugService({
    index,
    matcher,
    extractor,
    sourceStore,
    demoter,
    injector,
    llmExtractor,
    auditor,
    rewriter,
    cache,
    llmClient,
    maintenance,
    runtime,
    ledger,
    semipersistentLayer,
    bank,
    surfaceProjector,
    config: effectiveConfig,
  })
  runtime.debug = debug

  legacyMatcher.markDirty()
  legacyMatcher.warm()

  Object.defineProperties(index, {
    extractionEngine: { value: extractor, enumerable: false },
    matchEngine: { value: matcher, enumerable: false },
    demotionEngine: { value: demoter, enumerable: false },
    injectionEngine: { value: injector, enumerable: false },
    llmExtractor: { value: llmExtractor, enumerable: false },
    haluMemAuditor: { value: auditor, enumerable: false },
    fallbackRewriter: { value: rewriter, enumerable: false },
    semipersistentCache: { value: cache, enumerable: false },
    sensoryMaintenance: { value: maintenance, enumerable: false },
    sensoryDebug: { value: debug, enumerable: false },
    memoryLedger: { value: ledger, enumerable: false },
    semipersistentLayer: { value: semipersistentLayer, enumerable: false },
    memoryBank: { value: bank, enumerable: false },
    memorySurfaceProjector: { value: surfaceProjector, enumerable: false },
    layeredMemoryRuntime: { value: runtime, enumerable: false },
  })
  ctx.provide('sensoryIndex', index)
  ctx.provide('sensoryMatcher', matcher)
  ctx.provide('sensoryInjector', injector)
  ctx.provide('sensoryLlmExtractor', llmExtractor)
  ctx.provide('sensoryAuditor', auditor)
  ctx.provide('sensoryRewriter', rewriter)
  ctx.provide('sensoryCache', cache)
  ctx.provide('sensoryMaintenance', maintenance)
  ctx.provide('sensoryDebug', debug)
  ctx.provide('memoryLedger', ledger)
  ctx.provide('semipersistentLayer', semipersistentLayer)
  ctx.provide('memoryBank', bank)
  ctx.provide('memorySurfaceProjector', surfaceProjector)

  const services = {
    index,
    matcher,
    extractor,
    sourceStore,
    demoter,
    injector,
    llmExtractor,
    auditor,
    rewriter,
    cache,
    llmClient,
    auxiliaryRequests,
    maintenance,
    debug,
    runtime,
    ledger,
    semipersistentLayer,
    bank,
    surfaceProjector,
    planner,
    transitionReviewer,
    legacyMatcher,
  }

  if (config.indexScope === 'global') ctx.logger?.warn?.('[sensory-memory] indexScope=global is retired; Layered v2 forces session sensory scope')
  if (config.cleanupLegacyOnStart) ctx.logger?.warn?.('[sensory-memory] cleanupLegacyOnStart is retired; old global data remains untouched until explicit migration')

  installLayeredV2(ctx, config, services)

}

export { DemotionEngine, IndexSourceStore } from './demotion-engine.js'
export { adaptSensoryIndex, toEngramNode } from './engram-adapter.js'
export { ExtractionEngine } from './extraction-engine.js'
export { FallbackRewriter, recentContextSummary } from './fallback-rewriter.js'
export { HaluMemAuditor } from './halu-mem-auditor.js'
export { extractQuery, InjectionEngine } from './injection-engine.js'
export { LLMExtractor, LEGACY_NOISE_NAMES } from './llm-extractor.js'
export { LayeredMatchEngine } from './layered-match-engine.js'
export { LayeredMemoryRuntime } from './layered-memory-runtime.js'
export { MatchEngine } from './match-engine.js'
export { MemoryBank } from './memory-bank.js'
export { MemoryLedger } from './memory-ledger.js'
export { MemoryPolicy, activationOf, addAssociation, parseRememberDirective } from './memory-policy.js'
export { MemoryRetrievalPlanner } from './memory-retrieval-planner.js'
export { MemorySegmenter } from './memory-segmenter.js'
export { MemorySurfaceProjector } from './memory-surface-projector.js'
export { MemoryTransitionReviewer } from './memory-transition-reviewer.js'
export { SemipersistentCache } from './semipersistent-cache.js'
export { SemipersistentLayer } from './semipersistent-layer.js'
export { SensoryDebugService, SENSORY_DEBUG_OUTPUT_MODES } from './sensory-debug.js'
export { SensoryMaintenance } from './sensory-maintenance.js'
export { createSensoryToolDefinitions, defineTool, registerSensoryTools } from './sensory-tools.js'
export { SensoryIndex } from './sensory-index.js'
export { parseLlmJson, Stage4LlmClient } from './stage4-llm.js'
