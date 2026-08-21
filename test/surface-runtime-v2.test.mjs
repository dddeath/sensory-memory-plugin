import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ExtractionEngine } from '../lib/extraction-engine.js'
import { LayeredMatchEngine } from '../lib/layered-match-engine.js'
import { LayeredMemoryRuntime } from '../lib/layered-memory-runtime.js'
import { MemoryBank } from '../lib/memory-bank.js'
import { MemoryLedger } from '../lib/memory-ledger.js'
import { MemoryPolicy } from '../lib/memory-policy.js'
import { MemoryRetrievalPlanner } from '../lib/memory-retrieval-planner.js'
import { MemorySegmenter } from '../lib/memory-segmenter.js'
import { MemorySurfaceProjector } from '../lib/memory-surface-projector.js'
import { SemipersistentLayer } from '../lib/semipersistent-layer.js'
import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'surface-runtime-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'layered-v2'))
  const policy = new MemoryPolicy()
  const semi = new SemipersistentLayer({ ledger, policy })
  const bank = new MemoryBank({ ledger, semipersistentLayer: semi })
  const surface = new MemorySurfaceProjector({ ledger })
  const matcher = new LayeredMatchEngine({ ledger, bank })
  const planner = new MemoryRetrievalPlanner({ matcher, llm: null })
  const index = new SensoryIndex(join(dir, 'index'), { legacyMirror: false })
  const ctx = { workspaceRegistry: { async resolveByPath() { return { id: 'w' } } }, logger: { warn() {} }, llm: null }
  const runtime = new LayeredMemoryRuntime({ ctx, ledger, segmenter: new MemorySegmenter(), policy, semipersistentLayer: semi, bank, surfaceProjector: surface, matcher, planner, index, extractor: new ExtractionEngine(), sourceStore: null, config: { contextWindow: 2000, maxOutputTokens: 200 } })
  return { runtime, ledger, semi, bank, surface, matcher, index }
}

function session() {
  const replacements = []
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { id: 'u1', role: 'user', turn: 1, content: [{ type: 'text', text: '项目M的部署端口是8282。' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { seq: 2, time: 2, type: 'assistant/message', data: { turn: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '已记录。' }], source: { kind: 'model' } } }, surfaceOp: 'append' },
  ]
  return {
    id: 's', events, replacements,
    deriveMessages() { return events.map((event) => event.type === 'assistant/message' ? event.data.message : event.data) },
    append(type, data, options) { const event = { seq: events.length + 1, time: Date.now(), type, data, ...options }; events.push(event); replacements.push(event); return event },
  }
}

test('four inactive turns replace a complete historical segment with a session sensory checkpoint', async (t) => {
  const { runtime, ledger } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const current = { id: 'u5', role: 'user', content: [{ type: 'text', text: '完全无关的问题' }], source: { kind: 'user' } }
  await runtime.preStep({ agent, messages: [current], turn: 5, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(s.replacements.length, 1)
  assert.deepEqual(s.replacements[0].surfaceOp, { op: 'replace', start: 1, end: 2 })
  assert.equal(s.replacements[0].data.role, 'user')
  assert.equal(s.replacements[0].data.source.kind, 'plugin')
  assert.equal(s.replacements[0].data.source.purpose, 'sensory-checkpoint')
  assert.equal(ledger.list('sensoryEntries', { scopeKind: 'session', scopeId: 's' }).length > 0, true)
})

test('surface replacement publishes an exact token-meter shadow price immediately before the replacement', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-shadow-price-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const surface = new MemorySurfaceProjector({ ledger, tokenMeter: { estimateMessage: () => 11 } })
  const s = session()
  s.surface = { nodes: new Set([1, 2]) }
  const segment = { id: 'segment-priced', sessionId: 's', firstSeq: 1, lastSeq: 2, sourceSeqs: [1, 2], surfaceRevision: 0 }
  const result = surface.replaceSegment(s, segment, { text: 'checkpoint' })
  const price = s.events.at(-2)
  const replacement = s.events.at(-1)
  assert.equal(result.ok, true)
  assert.equal(price.type, 'compaction/prune')
  assert.deepEqual(price.data.shadowedRange, { start: 1, end: 2 })
  assert.deepEqual(price.data.shadowedSeqs, [1, 2])
  assert.equal(price.data.shadowedTokenCount, 22)
  assert.equal(replacement.type, 'user/message')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', start: 1, end: 2 })
  assert.deepEqual(replacement.sourceEventSeqs, [1, 2])
})

test('a visible DSH compact checkpoint migrates shadowed working segments to sensory and restores a root manifest', async (t) => {
  const { runtime, ledger } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const compact = {
    seq: 3,
    time: 3,
    type: 'user/message',
    data: { id: 'compact-1', role: 'user', content: [{ type: 'text', text: '<compacted-summary>summary</compacted-summary>' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } },
    surfaceOp: { op: 'replace', start: 1, end: 2 },
  }
  s.events.push(compact)
  s.surface = { nodes: new Set([3]) }
  s.deriveMessages = () => [compact.data]
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
  const decision = await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  const segment = ledger.list('sourceSegments', { scopeKind: 'session', scopeId: 's' })[0]
  assert.equal(segment.state, 'sensory')
  assert.equal(segment.replacementLineage.at(-1).transition, 'external-compaction')
  assert.equal(segment.replacementLineage.at(-1).compactionId, 'c1')
  assert.equal(ledger.list('sensoryEntries', { scopeKind: 'session', scopeId: 's' }).length > 0, true)
  assert.equal(decision.messages[0].source.purpose, 'sensory-root-manifest')
  assert.equal(runtime.status('s', 'w').stats.externalCompactionToSensory, 1)
  assert.equal(runtime.status('s', 'w').transitions[0].transition, 'external-compaction')
})

test('segmenter assigns user messages to the active turn when bridge seed stores turn only on turn/start', async (t) => {
  const { runtime } = fixture(t)
  const s = session()
  s.events.unshift({ seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } })
  delete s.events[0 + 1].data.turn
  const agent = { cwd: 'E:/bench', session: s }
  const stored = await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const segment = runtime.ledger.get('sourceSegments', (await stored).segmentId, { scopeKind: 'session', scopeId: 's' })
  assert.deepEqual(segment.records.map((record) => record.role), ['user', 'assistant'])
  assert.equal(segment.userText, '项目M的部署端口是8282。')
})

test('a live turn number reused after benchmark seed selects only the latest turn boundary', async (t) => {
  const { runtime } = fixture(t)
  const s = session()
  s.events.unshift({ seq: 0, time: 0, type: 'turn/start', data: { turn: 1 } })
  s.events.push(
    { seq: 3, time: 3, type: 'turn/end', data: { turn: 1 } },
    { seq: 4, time: 4, type: 'turn/start', data: { turn: 1 } },
    { seq: 5, time: 5, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '新的真实探针' }] } },
    { seq: 6, time: 6, type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '新回答' }] } } },
  )
  const pending = runtime.turnStopping({ agent: { cwd: 'E:/bench', session: s }, turn: 1 })
  const stored = await pending
  const segment = runtime.ledger.get('sourceSegments', stored.segmentId, { scopeKind: 'session', scopeId: 's' })
  assert.equal(segment.firstSeq, 5)
  assert.deepEqual(segment.records.map((record) => record.text), ['新的真实探针', '新回答'])
})

test('semipersistent snapshot and sensory catalog are plugin user messages immediately before the real user', async (t) => {
  const { runtime, ledger, semi } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  const seg = { id: 'semi1', segmentId: 'semi1', sessionId: 's', workspaceId: 'w', title: '项目S', turn: 1, sourceSeqs: [1], records: [{ seq: 1, role: 'user', text: '项目S端口是6060', blockKinds: ['text'] }], canonicalFacts: [{ subject: '项目S', predicate: '端口', value: '6060', current: true }], episodeSummary: '项目S端口是6060', evidenceQuality: 0.9, durability: 0.9, importance: 0.9, verifiedSource: true, associations: [], state: 'semipersistent' }
  semi.promote(seg, { workspaceId: 'w', sessionId: 's', workspaceTurn: 1 })
  ledger.upsert('sensoryEntries', { id: 'e1', title: '项目M', scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w', aliases: [], canonicalFacts: [{ subject: '项目M', predicate: '端口', value: '8282', current: true }], episodeSummary: '项目M端口8282', approvedEpisode: true, sourceRefs: [{ sessionId: 's', seq: 1 }], evidenceQuality: 0.9, verifiedSource: true }, { scopeKind: 'session', scopeId: 's', id: 'e1' })
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '项目M端口是多少' }], source: { kind: 'user' } }
  const decision = await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(decision.messages.map((message) => message.source?.purpose ?? 'real-user'), ['semipersistent-snapshot', 'sensory-catalog', 'real-user'])
  assert.equal(decision.messages.slice(0, 2).every((message) => message.role === 'user' && message.source.kind === 'plugin'), true)
})

test('unchanged semipersistent snapshots are reused and changed snapshots supersede the old surface event', (t) => {
  const { semi, surface } = fixture(t)
  const s = session()
  const seg = { id: 'semi-revision', segmentId: 'semi-revision', sessionId: 's', workspaceId: 'w', title: '项目R', turn: 1, sourceSeqs: [1], records: [{ seq: 1, role: 'user', text: '项目R端口是7070', blockKinds: ['text'] }], canonicalFacts: [], episodeSummary: '项目R端口是7070', evidenceQuality: 0.9, durability: 0.9, importance: 0.9, verifiedSource: true, associations: [], state: 'semipersistent' }
  semi.promote(seg, { workspaceId: 'w', sessionId: 's', workspaceTurn: 1 })
  const first = semi.renderSnapshot('s', 'w', { budgetTokens: 500 })
  const prior = { id: 'snapshot-old', role: 'user', content: [{ type: 'text', text: first.prompt }], source: { kind: 'plugin', purpose: 'semipersistent-snapshot', snapshotRevision: first.snapshotRevision } }
  s.events.push({ seq: 3, type: 'user/message', data: prior, surfaceOp: 'append' })
  assert.equal(surface.prepareSemipersistentSnapshot(s, first).action, 'reuse')
  semi.setProjection('semi-revision', 's', 'w', 'full-projection', { reason: 'fresh-use' })
  const changed = semi.renderSnapshot('s', 'w', { budgetTokens: 500 })
  const prepared = surface.prepareSemipersistentSnapshot(s, changed)
  assert.equal(prepared.action, 'supersede-and-insert')
  assert.deepEqual(s.replacements.at(-1).surfaceOp, { op: 'replace', start: 3, end: 3 })
  assert.equal(s.replacements.at(-1).data.source.purpose, 'semipersistent-superseded')
})

test('an expired final semipersistent projection replaces its prior snapshot with an empty superseded marker', (t) => {
  const { surface } = fixture(t)
  const s = session()
  const prior = { id: 'snapshot-last', role: 'user', content: [{ type: 'text', text: 'old snapshot' }], source: { kind: 'plugin', purpose: 'semipersistent-snapshot', snapshotRevision: 'old' } }
  s.events.push({ seq: 3, type: 'user/message', data: prior, surfaceOp: 'append' })
  const prepared = surface.prepareSemipersistentSnapshot(s, null)
  assert.equal(prepared.action, 'supersede-to-empty')
  assert.equal(s.replacements.at(-1).data.source.purpose, 'semipersistent-superseded')
})

test('explicit remember writes workspace bank and immediately activates a full semipersistent projection', async (t) => {
  const { runtime, bank, semi } = fixture(t)
  const s = session()
  s.events[0].data.content = [{ type: 'text', text: '记住：项目M的端口是8282' }]
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  assert.equal(bank.status('w').workspaceRecords, 1)
  assert.equal(semi.status('s', 'w').fullProjectionCount, 1)
})

test('forget tombstones bank retrieval and removes linked semipersistent projections immediately', async (t) => {
  const { runtime, bank, semi } = fixture(t)
  const s = session()
  s.events[0].data.content = [{ type: 'text', text: '记住：项目F的发布门是双人复核' }]
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  const record = bank.listVisible({ workspaceId: 'w' })[0]
  assert.ok(record)
  const forgotten = runtime.forget({ target: record.id, scope: 'workspace', sessionId: 's', workspaceId: 'w' })
  assert.deepEqual(forgotten.tombstoned, [record.id])
  assert.equal(bank.listVisible({ workspaceId: 'w' }).length, 0)
  assert.equal(semi.status('s', 'w').fullProjectionCount, 0)
})

test('benchmark finalize lands remaining working history while ordinary dispose-style drain keeps it working', async (t) => {
  const { runtime } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.drainSession('s')
  assert.equal(runtime.layerCounts('s', 'w').working, 1)
  const finalized = await runtime.finalizeSession('s')
  assert.equal(finalized.transitions[0].transition, 'working-to-sensory')
  assert.equal(runtime.layerCounts('s', 'w').working, 0)
})

test('archive freezes retrieval and unarchive restores the persisted session scope', async (t) => {
  const { runtime } = fixture(t)
  const s = session()
  s.header = { archived: true, cwd: 'E:/bench' }
  const agent = { cwd: 'E:/bench', session: s }
  const current = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }
  const archived = await runtime.preStep({ agent, messages: [current], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(archived.messages, [current])
  assert.equal(runtime.status('s', 'w').frozen, true)
  s.header.archived = false
  await runtime.preStep({ agent, messages: [current], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(runtime.status('s', 'w').frozen, false)
})

test('passive bank selection does not bypass the target-session semipersistent association gate', async (t) => {
  const { runtime, bank, semi } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  bank.put({ content: '蓝灯塔的验证短语是银杏-47', scopeKind: 'workspace', scopeId: 'w', sessionId: 'source-session', workspaceId: 'w', memoryType: 'verified-fact', explicit: true, sourceRefs: [{ sessionId: 'source-session', seq: 9 }] })
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '蓝灯塔的验证短语是什么' }], source: { kind: 'user' } }
  await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(semi.status('s', 'w').fullProjectionCount, 0)
})
