import { installLayeredV2 } from './install-layered-v2.js'
import { createPluginServices } from './plugin-services.js'

export const name = 'sensory-memory'
export const inject = ['systemPrompt', 'tools', 'llm', 'workspaceRegistry', 'tokenMeter']

export function apply(ctx, config = {}) {
  const { services } = createPluginServices(ctx, config)
  if (config.indexScope === 'global') {
    ctx.logger?.warn?.('[sensory-memory] indexScope=global is retired; Layered v2 forces session sensory scope')
  }
  if (config.cleanupLegacyOnStart) {
    ctx.logger?.warn?.('[sensory-memory] cleanupLegacyOnStart is retired; old global data remains untouched until explicit migration')
  }
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
export { buildRetrievalFeatures, retrievalTermIsSafe } from './memory-retrieval-features.js'
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
export { extractRecentTurnMessages, lastUserMessage } from './turn-messages.js'
