import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextChunker } from '../../lib/context-chunker.js'
import { LayeredMatchEngine } from '../../lib/layered-match-engine.js'
import { LayeredMemoryRuntime } from '../../lib/layered-memory-runtime.js'
import { MemoryBank } from '../../lib/memory-bank.js'
import { MemoryLedger } from '../../lib/memory-ledger.js'
import { MemoryPolicy } from '../../lib/memory-policy.js'
import { MemoryRetrievalPlanner } from '../../lib/memory-retrieval-planner.js'
import { MemorySegmenter } from '../../lib/memory-segmenter.js'
import { MemorySurfaceProjector } from '../../lib/memory-surface-projector.js'
import { SemipersistentLayer } from '../../lib/semipersistent-layer.js'
import { SurfaceBudgetController } from '../../lib/surface-budget-controller.js'
import { FeatureHashVectorEncoder } from '../../lib/vector-encoder.js'

export function runtimeFixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chunk-runtime-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const policy = new MemoryPolicy(config)
  const chunker = new ContextChunker(config)
  const vectorEncoder = config.vectorEncoder ?? new FeatureHashVectorEncoder({ dimensions: config.vectorDimensions ?? 128 })
  const semi = new SemipersistentLayer({ ledger, policy, config })
  const bank = new MemoryBank({ ledger, semipersistentLayer: semi, chunker, vectorEncoder, config })
  const surface = new MemorySurfaceProjector({ ledger, config })
  const surfaceBudgetController = new SurfaceBudgetController(config)
  const readSource = (ref) => {
    for (const segment of ledger.list('sourceSegments', { scopeKind: 'session', scopeId: ref.sessionId })) {
      const record = (segment.records ?? []).find((item) => Number(item.seq) === Number(ref.seq))
      if (record) return record
    }
    return null
  }
  const matcher = new LayeredMatchEngine({ ledger, bank, vectorEncoder, sourceReader: readSource, config })
  const planner = new MemoryRetrievalPlanner({ matcher, llm: config.plannerLlm ?? null, config })
  const ctx = { workspaceRegistry: { async resolveByPath() { return { id: 'w' } } }, logger: { warn() {} }, llm: null }
  const runtime = new LayeredMemoryRuntime({
    ctx,
    ledger,
    segmenter: new MemorySegmenter(config),
    policy,
    semipersistentLayer: semi,
    bank,
    surfaceProjector: surface,
    surfaceBudgetController,
    matcher,
    planner,
    chunker,
    vectorEncoder,
    config: { contextWindow: 2000, maxOutputTokens: 200, ...config },
  })
  return { dir, runtime, ledger, policy, chunker, vectorEncoder, semi, bank, surface, surfaceBudgetController, matcher, planner, readSource }
}

export function testSession({ id = 's', userText = '项目M的部署端口是8282。', assistantText = '已记录。' } = {}) {
  const replacements = []
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { id: 'u1', role: 'user', turn: 1, content: [{ type: 'text', text: userText }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'assistant/message', data: { turn: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: assistantText }], source: { kind: 'model' } } }, surfaceOp: 'append' },
  ]
  return {
    id,
    events,
    replacements,
    header: { cwd: 'E:/bench' },
    deriveMessages() { return events.map((event) => event.type === 'assistant/message' ? event.data.message : event.data) },
    append(type, data, options) {
      const event = { seq: Math.max(0, ...events.map((item) => Number(item.seq) || 0)) + 1, time: Date.now(), type, data, ...options }
      events.push(event)
      replacements.push(event)
      return event
    },
  }
}

export async function storeTurn(runtime, session, turn = 1) {
  const result = await runtime.turnStopping({ agent: { cwd: 'E:/bench', session }, turn })
  await runtime.ledger.drain(`session:${session.id}`, 1000)
  return result
}
