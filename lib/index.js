import { join, resolve } from 'node:path'

import { DemotionEngine, IndexSourceStore, messageTextOf } from './demotion-engine.js'
import { ExtractionEngine } from './extraction-engine.js'
import { FallbackRewriter } from './fallback-rewriter.js'
import { HaluMemAuditor } from './halu-mem-auditor.js'
import { extractQuery, InjectionEngine } from './injection-engine.js'
import { LLMExtractor } from './llm-extractor.js'
import { MatchEngine } from './match-engine.js'
import { SemipersistentCache } from './semipersistent-cache.js'
import { SensoryDebugService } from './sensory-debug.js'
import { SensoryIndex } from './sensory-index.js'
import { pendingCandidate, SensoryMaintenance } from './sensory-maintenance.js'
import { installStage3 } from './stage3.js'
import { Stage4LlmClient } from './stage4-llm.js'

export const name = 'sensory-memory'
export const inject = ['systemPrompt', 'tools', 'llm']

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
  const index = new SensoryIndex(config.indexDir || defaultIndexDir(), { ...config, legacyMirror: false })
  const extractor = new ExtractionEngine()
  const matcher = new MatchEngine(index, config)
  const sourceStore = new IndexSourceStore(index)
  const demoter = new DemotionEngine({ index, extractor, sourceStore, matcher, config })
  const injector = new InjectionEngine({ matcher, config })
  const auxiliaryRequests = new WeakSet()
  const llmClient = new Stage4LlmClient({ llm: ctx.llm, config, auxiliaryRequests })
  const llmExtractor = new LLMExtractor({ llm: llmClient, index, config })
  const auditor = new HaluMemAuditor({ index, llm: llmClient, config })
  const rewriter = new FallbackRewriter({ matcher, llm: llmClient, config })
  const cache = new SemipersistentCache({ index, config })
  const maintenance = new SensoryMaintenance({ index, demoter, matcher, llmExtractor, cache, rewriter, config })
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
    config,
  })

  const cleanup = llmExtractor.config.cleanupLegacyOnStart
    ? llmExtractor.migrateLegacyOnce()
    : null
  matcher.markDirty()
  matcher.warm()
  matcher.onHit = (entityId, viewer) => cache.onHit(entityId, viewer)
  injector.priorityCatalog = (hits) => cache.renderPriority(hits)

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
  }
  installStage3(ctx, config, services)

  if (cleanup && !cleanup.skipped) {
    ctx.logger?.info?.(
      '[sensory-memory] legacy cleanup before=%d after=%d removed=%d reduction=%d%%',
      cleanup.before,
      cleanup.after,
      cleanup.removed,
      Math.round(cleanup.reductionRate * 100),
    )
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      if (debug.consumeTurnStoppingSkip(agent.session.id, turn)) {
        ctx.logger?.info?.('[sensory-memory] turn=%d skipped demotion after explicit index clear', turn)
        return
      }
      injector.setSession(agent.session)
      const messages = extractRecentTurnMessages(agent.session.deriveMessages(), turn, agent.session)
      const result = await demoter.onTurnEnd({
        turn,
        messages,
        queryText: lastUserMessage(messages),
        sessionId: agent.session.id,
      })
      const scopeId = maintenance.scopeFor(agent.session.id)
      const candidate = pendingCandidate(result, demoter, index, scopeId)
      if (candidate) {
        void llmExtractor.settle([candidate]).then(() => {
          matcher.markDirty()
          matcher.warm()
        }).catch((error) => {
          ctx.logger?.warn?.('[sensory-memory] async refine failed: %s', String(error))
        })
      }
      ctx.logger?.info?.(
        '[sensory-memory] turn=%d tracked=%d demoted=%d',
        turn,
        result.tracked,
        result.demoted,
      )
    } catch (error) {
      ctx.logger?.warn?.('[sensory-memory] turn-stopping failed: %s', String(error))
    }
  })

  ctx.effect(() => async () => {
    const drained = await maintenance.drain(null, { timeoutMs: config.shutdownDrainTimeoutMs ?? 30_000 })
    if (!drained.ok) ctx.logger?.warn?.('[sensory-memory] shutdown drain incomplete: %s', JSON.stringify(drained))
  }, 'sensory-memory: maintenance drain')

}

export { DemotionEngine, IndexSourceStore } from './demotion-engine.js'
export { adaptSensoryIndex, toEngramNode } from './engram-adapter.js'
export { ExtractionEngine } from './extraction-engine.js'
export { FallbackRewriter, recentContextSummary } from './fallback-rewriter.js'
export { HaluMemAuditor } from './halu-mem-auditor.js'
export { extractQuery, InjectionEngine } from './injection-engine.js'
export { LLMExtractor, LEGACY_NOISE_NAMES } from './llm-extractor.js'
export { MatchEngine } from './match-engine.js'
export { SemipersistentCache } from './semipersistent-cache.js'
export { SensoryDebugService, SENSORY_DEBUG_OUTPUT_MODES } from './sensory-debug.js'
export { SensoryMaintenance } from './sensory-maintenance.js'
export { createSensoryToolDefinitions, defineTool, registerSensoryTools } from './sensory-tools.js'
export { SensoryIndex } from './sensory-index.js'
export { parseLlmJson, Stage4LlmClient } from './stage4-llm.js'
