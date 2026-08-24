import { installChunkMemory } from './install-chunk-memory.js'
import { createPluginServices } from './plugin-services.js'

export const name = 'sensory-memory'
export const inject = ['systemPrompt', 'tools', 'llm', 'tokenMeter']

export function apply(ctx, config = {}) {
  const { services } = createPluginServices(ctx, config)
  if (config.indexScope === 'global') {
    ctx.logger?.warn?.('[sensory-memory] indexScope=global is retired; chunk memory uses session sensory scope')
  }
  if (config.cleanupLegacyOnStart) {
    ctx.logger?.warn?.('[sensory-memory] cleanupLegacyOnStart is retired; old global data remains untouched until explicit migration')
  }
  installChunkMemory(ctx, config, services)
}

export { ContextChunker, contextChunkInternals } from './context-chunker.js'
export { estimateTokens, protectToolPairBoundary } from './context-utils.js'
export { LayeredMatchEngine } from './layered-match-engine.js'
export { LayeredMemoryRuntime } from './layered-memory-runtime.js'
export { MemoryBank } from './memory-bank.js'
export { MemoryLedger } from './memory-ledger.js'
export { MemoryPolicy, activationOf, addAssociation, parseRememberDirective } from './memory-policy.js'
export { MemoryRetrievalPlanner } from './memory-retrieval-planner.js'
export { MemorySegmenter } from './memory-segmenter.js'
export { MemorySurfaceProjector } from './memory-surface-projector.js'
export { MemoryTransitionReviewer } from './memory-transition-reviewer.js'
export { SemipersistentLayer } from './semipersistent-layer.js'
export { createStandaloneSession, StandaloneChunkMemory } from './standalone-chunk-memory.js'
export { SensoryDebugService, SENSORY_DEBUG_OUTPUT_MODES } from './sensory-debug.js'
export { SensoryMaintenance } from './sensory-maintenance.js'
export { createSensoryToolDefinitions, defineTool, registerSensoryTools } from './sensory-tools.js'
export { parseLlmJson, Stage4LlmClient } from './stage4-llm.js'
export { cosineSimilarity, createVectorEncoder, FeatureHashVectorEncoder, HttpVectorEncoder, LexicalOnlyVectorEncoder } from './vector-encoder.js'
