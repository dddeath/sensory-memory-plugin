import { join, resolve } from 'node:path'

import { DemotionEngine, IndexSourceStore } from './demotion-engine.js'
import { ExtractionEngine } from './extraction-engine.js'
import { FallbackRewriter } from './fallback-rewriter.js'
import { HaluMemAuditor } from './halu-mem-auditor.js'
import { InjectionEngine } from './injection-engine.js'
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
import { SemipersistentLayer } from './semipersistent-layer.js'
import { SensoryDebugService } from './sensory-debug.js'
import { SensoryIndex } from './sensory-index.js'
import { SensoryMaintenance } from './sensory-maintenance.js'
import { Stage4LlmClient } from './stage4-llm.js'

const PROVIDED_SERVICES = {
  sensoryIndex: 'index',
  sensoryMatcher: 'matcher',
  sensoryInjector: 'injector',
  sensoryLlmExtractor: 'llmExtractor',
  sensoryAuditor: 'auditor',
  sensoryRewriter: 'rewriter',
  sensoryCache: 'cache',
  sensoryMaintenance: 'maintenance',
  sensoryDebug: 'debug',
  memoryLedger: 'ledger',
  semipersistentLayer: 'semipersistentLayer',
  memoryBank: 'bank',
  memorySurfaceProjector: 'surfaceProjector',
}

const INDEX_SERVICE_PROPERTIES = {
  extractionEngine: 'extractor',
  matchEngine: 'matcher',
  demotionEngine: 'demoter',
  injectionEngine: 'injector',
  llmExtractor: 'llmExtractor',
  haluMemAuditor: 'auditor',
  fallbackRewriter: 'rewriter',
  semipersistentCache: 'cache',
  sensoryMaintenance: 'maintenance',
  sensoryDebug: 'debug',
  memoryLedger: 'ledger',
  semipersistentLayer: 'semipersistentLayer',
  memoryBank: 'bank',
  memorySurfaceProjector: 'surfaceProjector',
  layeredMemoryRuntime: 'runtime',
}

function defaultIndexDir() {
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.cwd(), '.dsh')
  return resolve(dshHome, 'sensory-index')
}

function attachIndexServices(index, services) {
  const descriptors = Object.fromEntries(Object.entries(INDEX_SERVICE_PROPERTIES).map(([property, service]) => [
    property,
    { value: services[service], enumerable: false },
  ]))
  Object.defineProperties(index, descriptors)
}

function provideServices(ctx, services) {
  for (const [publicName, serviceName] of Object.entries(PROVIDED_SERVICES)) {
    ctx.provide(publicName, services[serviceName])
  }
}

export function createPluginServices(ctx, config = {}) {
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
  const matcher = new LayeredMatchEngine({
    ledger,
    bank,
    sourceReader: (sourceRef) => index.readSource(sourceRef),
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
  attachIndexServices(index, services)
  provideServices(ctx, services)
  return { effectiveConfig, services }
}
