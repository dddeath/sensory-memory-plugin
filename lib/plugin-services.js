import { join, resolve } from 'node:path'

import { ContextChunker } from './context-chunker.js'
import { LayeredMatchEngine } from './layered-match-engine.js'
import { LayeredMemoryRuntime } from './layered-memory-runtime.js'
import { MemoryBank } from './memory-bank.js'
import { MemoryLedger } from './memory-ledger.js'
import { MemoryPolicy } from './memory-policy.js'
import { MemoryRetrievalPlanner } from './memory-retrieval-planner.js'
import { MemorySegmenter } from './memory-segmenter.js'
import { MemorySurfaceProjector } from './memory-surface-projector.js'
import { MemoryTransitionReviewer } from './memory-transition-reviewer.js'
import { SemipersistentLayer } from './semipersistent-layer.js'
import { SensoryDebugService } from './sensory-debug.js'
import { SensoryMaintenance } from './sensory-maintenance.js'
import { Stage4LlmClient } from './stage4-llm.js'
import { createVectorEncoder } from './vector-encoder.js'

const PROVIDED_SERVICES = {
  sensoryChunks: 'ledger',
  sensoryMatcher: 'matcher',
  sensoryCache: 'cache',
  sensoryMaintenance: 'maintenance',
  sensoryDebug: 'debug',
  memoryLedger: 'ledger',
  semipersistentLayer: 'semipersistentLayer',
  memoryBank: 'bank',
  memorySurfaceProjector: 'surfaceProjector',
  memoryChunker: 'chunker',
  memoryVectorEncoder: 'vectorEncoder',
}

function defaultMemoryDir() {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
  return resolve(dshHome, 'sensory-index')
}

function provideServices(ctx, services) {
  for (const [publicName, serviceName] of Object.entries(PROVIDED_SERVICES)) {
    ctx.provide(publicName, services[serviceName])
  }
}

export function createPluginServices(ctx, config = {}) {
  const environmentInputCap = Number(process.env.DSH_MEMORY_EFFECTIVE_INPUT_CAP_TOKENS)
  const environmentVectorRequired = /^(?:1|true|yes)$/i.test(String(process.env.DSH_MEMORY_VECTOR_REQUIRED ?? ''))
  const environmentLlmProvider = String(process.env.DSH_MEMORY_LLM_PROVIDER ?? '').trim()
  const environmentLlmModel = String(process.env.DSH_MEMORY_LLM_MODEL ?? '').trim()
  const effectiveConfig = {
    ...config,
    ...(Number.isInteger(environmentInputCap) && environmentInputCap > 0
      ? { effectiveInputCapTokens: environmentInputCap }
      : {}),
    ...(environmentVectorRequired ? { vectorRequired: true } : {}),
    ...(environmentLlmProvider ? { llmProvider: environmentLlmProvider } : {}),
    ...(environmentLlmModel ? { llmModel: environmentLlmModel } : {}),
    indexScope: 'session',
  }
  const memoryDir = config.indexDir || defaultMemoryDir()
  const auxiliaryRequests = new WeakSet()
  const llmClient = new Stage4LlmClient({ llm: ctx.llm, config: effectiveConfig, auxiliaryRequests })
  const ledger = new MemoryLedger(join(memoryDir, 'chunk-memory-v2'), effectiveConfig)
  const chunker = new ContextChunker(effectiveConfig)
  const vectorEncoder = createVectorEncoder(effectiveConfig)
  const segmenter = new MemorySegmenter(effectiveConfig)
  const policy = new MemoryPolicy(effectiveConfig)
  const semipersistentLayer = new SemipersistentLayer({ ledger, policy, config: effectiveConfig })
  const bank = new MemoryBank({ ledger, semipersistentLayer, chunker, vectorEncoder, config: effectiveConfig })
  const surfaceProjector = new MemorySurfaceProjector({ ledger, tokenMeter: ctx.tokenMeter, config: effectiveConfig })
  const matcher = new LayeredMatchEngine({
    ledger,
    bank,
    vectorEncoder,
    sourceReader: (sourceRef) => {
      const segments = ledger.list('sourceSegments', { scopeKind: 'session', scopeId: sourceRef?.sessionId })
      for (const segment of segments) {
        const record = (segment.records ?? []).find((item) => Number(item.seq) === Number(sourceRef?.seq))
        if (record) return record
      }
      return null
    },
    config: effectiveConfig,
  })
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
    chunker,
    vectorEncoder,
    auxiliaryRequests,
  })
  const cache = semipersistentLayer
  const maintenance = new SensoryMaintenance({ matcher, cache, runtime, config: effectiveConfig })
  const debug = new SensoryDebugService({
    matcher,
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

  const services = {
    matcher,
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
    chunker,
    vectorEncoder,
  }
  provideServices(ctx, services)
  return { effectiveConfig, services }
}
