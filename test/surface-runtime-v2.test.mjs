import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryLedger } from '../lib/memory-ledger.js'
import { mergeSegmentsToParentGroup } from '../lib/layered-memory-records.js'
import { MemorySurfaceProjector } from '../lib/memory-surface-projector.js'
import { renderParentPointer } from '../lib/pointer-label-compressor.js'
import { inject } from '../lib/index.js'
import { runtimeFixture, testSession } from './helpers/runtime-fixture.mjs'

function fixture(t) {
  return runtimeFixture(t)
}

function session() {
  return testSession()
}

test('headless activation keeps workspaceRegistry optional and falls back to normalized cwd identity', async (t) => {
  const { runtime } = fixture(t)
  delete runtime.ctx.workspaceRegistry
  const resolved = await runtime.workspace({ cwd: 'E:/bench' })
  assert.equal(inject.includes('workspaceRegistry'), false)
  assert.equal(resolved.resolution, 'fallback-path')
  assert.match(resolved.workspaceId, /bench/i)
})

test('four inactive turns stay verbatim below context pressure', async (t) => {
  const { runtime, ledger } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const current = { id: 'u5', role: 'user', content: [{ type: 'text', text: '完全无关的问题' }], source: { kind: 'user' } }
  await runtime.preStep({ agent, messages: [current], turn: 5, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(s.replacements.length, 0)
  assert.equal(ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' }).length, 0)
  assert.equal(runtime.status('s', 'w').stats.preThresholdBypasses, 1)
})

test('context pressure replaces the cold complete segment with a session sensory checkpoint', async (t) => {
  const { runtime, ledger } = runtimeFixture(t, { effectiveInputCapTokens: 8 })
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const current = { id: 'u5', role: 'user', content: [{ type: 'text', text: '完全无关的问题' }], source: { kind: 'user' } }
  await runtime.preStep({ agent, messages: [current], turn: 5, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(s.replacements.length, 4)
  assert.deepEqual(s.replacements[0].surfaceOp, { op: 'replace', start: 1, end: 2 })
  assert.equal(s.replacements[0].data.role, 'user')
  assert.equal(s.replacements[0].data.source.kind, 'plugin')
  assert.equal(s.replacements[0].data.source.purpose, 'sensory-checkpoint')
  assert.match(s.replacements[0].data.content[0].text, /^⟦p[0-9a-z-]+⟧ \[1-2\]/u)
  assert.equal(s.replacements[0].data.content[0].text.includes('children:'), false)
  assert.equal(s.replacements[0].data.content[0].text.includes('sourceRefs:'), false)
  assert.equal(s.replacements.at(-1).type, 'assistant/message')
  assert.deepEqual(s.replacements.at(-1).data.message.content, [])
  const [parent] = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' })
  assert.equal(parent.surfaceResidency, 'detached')
  assert.equal(parent.pointer.mode, 'none')
  const recalled = await runtime.matcher.retrieveAsync('项目M部署端口8282', { sessionId: 's', workspaceId: 'w' })
  assert.equal(recalled.candidates.some((candidate) => candidate.id === parent.id), true)
})

test('standard Parent pointer keeps a deterministic label within 24 estimated tokens', () => {
  const parent = {
    id: 'very-long-parent-id-that-never-enters-the-provider-pointer',
    firstSeq: 120,
    lastSeq: 137,
    parentIndex: 0,
    documentTitle: '关于项目M生产环境发布流程以及部署端口调整情况的讨论记录',
  }
  const first = renderParentPointer(parent)
  const second = renderParentPointer(parent)
  assert.deepEqual(first, second)
  assert.equal(first.estimatedTokens <= 24, true)
  assert.match(first.text, /^⟦p[0-9a-z-]+⟧ \[120-137\]/u)
  assert.equal(first.text.includes(parent.id), false)
  assert.equal(first.label.length <= 32, true)
})

test('adjacent sealed turns merge into one Parent while preserving Child offsets and source refs', () => {
  const makeSegment = (turn, firstSeq, text) => ({
    id: `seg-${turn}`,
    segmentId: `seg-${turn}`,
    sessionId: 's',
    workspaceId: 'w',
    turn,
    firstSeq,
    lastSeq: firstSeq + 1,
    sourceSeqs: [firstSeq, firstSeq + 1],
    records: [{ seq: firstSeq, role: 'user', sourceKind: 'user', text }],
    contextChunks: [{
      id: `seg-${turn}:parent:001`,
      parentIndex: 0,
      documentTitle: `turn-${turn}`,
      coreText: text,
      tokenCount: 20,
      childSpans: [{ childId: `old-${turn}`, startOffset: 0, endOffset: text.length, embeddingText: text, vector: { values: [1, 0] } }],
    }],
    importance: 0.5,
    durability: 0.5,
    evidenceQuality: 0.85,
    verifiedSource: true,
    associations: [],
    createdAt: firstSeq,
  })
  const merged = mergeSegmentsToParentGroup([
    makeSegment(1, 1, '项目M生产端口8383'),
    makeSegment(2, 3, '负责人林澄'),
    makeSegment(3, 5, '备用代号CEDAR-9'),
  ], { parentMaxTurns: 8, parentMaxTokens: 3000 })
  assert.deepEqual(merged.memberSegmentIds, ['seg-1', 'seg-2', 'seg-3'])
  assert.equal(merged.contextChunks.length, 1)
  assert.equal(merged.contextChunks[0].childSpans.length, 3)
  assert.equal(merged.contextChunks[0].sourceRefs.length, 6)
  assert.equal(merged.contextChunks[0].childSpans[1].startOffset > merged.contextChunks[0].childSpans[0].endOffset, true)
  assert.equal(merged.contextChunks[0].childSpans.every((child) => child.parentId === merged.contextChunks[0].id), true)
})

test('benchmark finalize groups adjacent working turns into one sensory Parent', async (t) => {
  const { runtime, ledger } = fixture(t)
  const s = session()
  s.events.push(
    { seq: 3, time: 3, type: 'user/message', data: { id: 'u2', role: 'user', turn: 2, content: [{ type: 'text', text: '项目M负责人是林澄。' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { seq: 4, time: 4, type: 'assistant/message', data: { turn: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '已记录。' }], source: { kind: 'model' } } }, surfaceOp: 'append' },
    { seq: 5, time: 5, type: 'user/message', data: { id: 'u3', role: 'user', turn: 3, content: [{ type: 'text', text: '备用代号是CEDAR-9。' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { seq: 6, time: 6, type: 'assistant/message', data: { turn: 3, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: '已记录。' }], source: { kind: 'model' } } }, surfaceOp: 'append' },
  )
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.turnStopping({ agent, turn: 2 })
  await runtime.turnStopping({ agent, turn: 3 })
  await runtime.ledger.drain('session:s', 1000)
  const finalized = await runtime.finalizeSession('s')
  const parents = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' })
  assert.equal(finalized.transitions.length, 1)
  assert.equal(finalized.transitions[0].grouped, true)
  assert.equal(finalized.transitions[0].memberSegmentIds.length, 3)
  assert.equal(parents.length, 1)
  assert.equal(parents[0].memberSegmentIds.length, 3)
  assert.equal(runtime.layerCounts('s', 'w').working, 0)
  assert.deepEqual(s.replacements[0].surfaceOp, { op: 'replace', start: 1, end: 6 })
})

test('one multi-chunk segment owns one Provider surface pointer', async (t) => {
  const { runtime, ledger } = runtimeFixture(t, { parentMaxTokens: 3000 })
  const s = testSession({
    userText: `文档开始\n${'项目M的部署记录与负责人说明。'.repeat(700)}\n文档结束`,
    assistantText: '已记录。',
  })
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  await runtime.finalizeSession('s')
  const parents = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' })
  assert.equal(parents.length > 1, true)
  assert.equal(parents.filter((parent) => parent.surfacePointerOwner === true).length, 1)
  assert.equal(parents.filter((parent) => parent.surfaceResidency === 'labeled-pointer').length, 1)
  assert.equal(parents.filter((parent) => parent.surfaceResidency === 'detached').length, parents.length - 1)
  assert.equal(runtime.layerCounts('s', 'w').surfaceResidency.surfacePointerCount, 1)
})

test('legacy sibling chunks sharing one pointer are rewritten once per compression level', async (t) => {
  const { runtime, ledger } = runtimeFixture(t, { effectiveInputCapTokens: 4 })
  const events = [{
    seq: 1,
    type: 'user/message',
    data: { id: 'pointer-old', role: 'user', content: [{ type: 'text', text: '⟦p1-2-0⟧ [1-2] old label' }], source: { kind: 'plugin', purpose: 'sensory-checkpoint' } },
  }]
  const nodes = [1]
  const replacements = []
  const s = {
    id: 's',
    events,
    replacements,
    header: { cwd: 'E:/bench' },
    get surface() { return { nodes } },
    deriveMessages() {
      return nodes.map((seq) => events.find((event) => event.seq === seq))
        .map((event) => event?.type === 'assistant/message' ? event.data.message : event?.data)
        .filter((message) => message?.content?.length !== 0)
    },
    append(type, data, options = {}) {
      const event = { seq: Math.max(...events.map((item) => item.seq)) + 1, type, data, ...options }
      if (options.surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(options.surfaceOp.start)
        const end = nodes.indexOf(options.surfaceOp.end)
        if (start < 0 || end < 0) throw new Error(`invalid test surface range ${options.surfaceOp.start}-${options.surfaceOp.end}`)
        nodes.splice(start, end - start + 1, event.seq)
        replacements.push(event)
      } else {
        nodes.push(event.seq)
      }
      events.push(event)
      return event
    },
  }
  ledger.upsert('sourceSegments', {
    id: 'segment-old', segmentId: 'segment-old', sessionId: 's', workspaceId: 'w', state: 'sensory',
    replacementLineage: [{ transition: 'context-pressure' }], records: [], sourceSeqs: [1], firstSeq: 1, lastSeq: 1,
  }, { scopeKind: 'session', scopeId: 's', id: 'segment-old' })
  for (let index = 0; index < 2; index += 1) {
    ledger.upsert('sensoryChunks', {
      id: `parent-${index}`, parentIndex: index, segmentId: 'segment-old', sessionId: 's', workspaceId: 'w',
      scopeKind: 'session', scopeId: 's', kind: 'context-parent', state: 'active', coreText: `项目M证据${index}`,
      sourceRefs: [{ sessionId: 's', seq: 1 }], evidenceSourceRefs: [{ sessionId: 's', seq: 1 }], evidenceQuality: 0.9,
      verifiedSource: true, temporalCurrent: true, surfaceResidency: 'labeled-pointer',
      pointer: { pointerId: 'p1-2-0', mode: 'labeled', label: 'old label', eventSeq: 1, estimatedTokens: 20, contentTokens: 20, revision: 1 },
      associations: [], firstSeq: 1, lastSeq: 1,
    }, { scopeKind: 'session', scopeId: 's', id: `parent-${index}` })
  }
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
  await runtime.preStep({ agent: { cwd: 'E:/bench', session: s }, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  const parents = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' })
  assert.equal(replacements.length, 3)
  assert.deepEqual(replacements.map((event) => event.surfaceOp.start), [1, replacements[0].seq, replacements[1].seq])
  assert.equal(parents.every((parent) => parent.surfaceResidency === 'detached'), true)
  assert.equal(runtime.layerCounts('s', 'w').surfaceResidency.surfacePointerCount, 0)
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

test('detached Parent replacement remains in raw events and produces zero derived Provider messages', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-detached-parent-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const surface = new MemorySurfaceProjector({ ledger, tokenMeter: { estimateMessage: () => 5 } })
  const events = [{
    seq: 1,
    type: 'user/message',
    data: { id: 'pointer', role: 'user', content: [{ type: 'text', text: '⟦p1-2-0⟧ [1-2]' }], source: { kind: 'plugin', purpose: 'sensory-checkpoint' } },
    surfaceOp: 'append',
  }]
  const nodes = [1]
  const s = {
    id: 's',
    events,
    surface: { get nodes() { return nodes } },
    deriveMessages() {
      return nodes.map((seq) => events.find((event) => event.seq === seq))
        .map((event) => event.type === 'assistant/message' ? event.data.message : event.data)
        .filter((message) => message?.content?.length !== 0)
    },
    append(type, data, options = {}) {
      const event = { seq: events.length + 1, type, data, ...options }
      events.push(event)
      if (options.surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(options.surfaceOp.start)
        const end = nodes.indexOf(options.surfaceOp.end)
        nodes.splice(start, end - start + 1, event.seq)
      }
      return event
    },
  }
  const parent = {
    id: 'parent-1',
    sessionId: 's',
    turn: 1,
    pointer: { pointerId: 'p1-2-0', eventSeq: 1, revision: 1 },
  }
  const result = surface.detachSensoryPointer(s, parent)
  assert.equal(result.ok, true)
  assert.equal(result.lineage.surfaceMessageProduced, false)
  assert.equal(result.event.type, 'assistant/message')
  assert.equal(s.deriveMessages().length, 0)
  assert.equal(events[0].data.content[0].text, '⟦p1-2-0⟧ [1-2]')
  assert.equal(events.some((event) => event.type === 'compaction/prune'), true)
})

test('an already shadowed source range transitions without emitting an invalid replace op', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-already-shadowed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const surface = new MemorySurfaceProjector({ ledger })
  const s = session()
  s.surface = { nodes: new Set([99]) }
  const segment = { id: 'segment-shadowed', sessionId: 's', firstSeq: 1, lastSeq: 2, sourceSeqs: [1, 2], surfaceRevision: 0 }
  const result = surface.replaceSegment(s, segment, { text: 'checkpoint', transition: 'context-pressure' })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'source-range-not-visible')
  assert.equal(result.lineage.surfaceAlreadyAbsent, true)
  assert.equal(result.surfaceRevision, 0)
  assert.equal(s.replacements.length, 0)
})

test('a partially shadowed source range is reported before DSH append', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-partially-shadowed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const surface = new MemorySurfaceProjector({ ledger: new MemoryLedger(join(dir, 'ledger')) })
  const s = session()
  s.surface = { nodes: new Set([2]) }
  const result = surface.replaceSegment(s, { id: 'partial', sessionId: 's', firstSeq: 1, lastSeq: 2, surfaceRevision: 0 }, { text: 'checkpoint' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'source-range-boundary-not-visible')
  assert.equal(result.startVisible, false)
  assert.equal(result.endVisible, true)
  assert.equal(s.replacements.length, 0)
})

test('effective input cap uses the DSH token meter on the same pressure axis as native compaction', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-pressure-axis-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const tokenMeter = {
    measure() { return { totalTokens: 68, surfaceTokens: 60, baseline: { kind: 'estimated', tokens: 68 }, logRevision: 9 } },
  }
  const surface = new MemorySurfaceProjector({ ledger, tokenMeter, config: { effectiveInputCapTokens: 100, contextPressureRatio: 0.65, contextPressureTargetRatio: 0.55 } })
  const budget = surface.budget({ sessionId: 's', session: {}, contextWindow: 1000, maxOutputTokens: 200, request: { messages: [] } })
  assert.equal(budget.usableInputTokens, 100)
  assert.equal(budget.estimatedInputTokens, 68)
  assert.equal(budget.pressure, 0.68)
  assert.equal(budget.pressureTriggered, true)
  assert.equal(budget.pressureThresholdTokens, 65)
  assert.equal(budget.pressureTargetTokens, 55)
  assert.equal(budget.pressureSource, 'dsh-token-meter:estimated')
  assert.equal(budget.effectiveInputCapSource, 'explicit-config')
})

test('explicit effective cap overrides stale provider context metadata', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-explicit-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(join(dir, 'ledger'))
  const tokenMeter = { measure: () => ({ totalTokens: 131_072, surfaceTokens: 100_000, baseline: { kind: 'usage' }, logRevision: 3 }) }
  const surface = new MemorySurfaceProjector({ ledger, tokenMeter, config: { effectiveInputCapTokens: 262_144, contextPressureRatio: 0.65 } })
  const budget = surface.budget({ sessionId: 's', session: {}, contextWindow: 128_000, maxOutputTokens: 8_192 })
  assert.equal(budget.contextWindow, 128_000)
  assert.equal(budget.routedUsableInputTokens, 119_808)
  assert.equal(budget.usableInputTokens, 262_144)
  assert.equal(budget.pressure, 0.5)
  assert.equal(budget.pressureTriggered, false)
  assert.equal(budget.effectiveInputCapSource, 'explicit-config')
})

test('a visible DSH compact checkpoint migrates shadowed working segments without a model-visible root manifest', async (t) => {
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
  assert.equal(ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' }).length > 0, true)
  assert.equal(decision.messages.some((message) => message.source?.purpose === 'sensory-root-manifest'), false)
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
  const { runtime, ledger, semi, vectorEncoder } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  const seg = { id: 'semi1', segmentId: 'semi1', sessionId: 's', workspaceId: 'w', label: '项目S上下文', turn: 1, sourceSeqs: [1], records: [{ seq: 1, role: 'user', sourceKind: 'user', text: '项目S端口是6060', blockKinds: ['text'] }], contextChunks: [], evidenceQuality: 0.9, durability: 0.9, importance: 0.9, verifiedSource: true, associations: [], state: 'semipersistent' }
  semi.promote(seg, { workspaceId: 'w', sessionId: 's', workspaceTurn: 1 })
  ledger.upsert('sourceSegments', {
    id: 'sensory-source', sessionId: 's', state: 'sensory',
    replacementLineage: [{ transition: 'context-pressure' }],
    records: [{ seq: 1, role: 'user', sourceKind: 'user', text: '项目M端口8282' }],
  }, { scopeKind: 'session', scopeId: 's', id: 'sensory-source' })
  ledger.upsert('sensoryChunks', { id: 'chunk-m', kind: 'context-chunk', label: '项目M上下文', scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w', segmentId: 'sensory-source', coreText: '项目M端口8282', contextText: '项目M端口8282', vector: vectorEncoder.encodeSync('项目M端口8282'), sourceRefs: [{ sessionId: 's', seq: 1 }], evidenceQuality: 0.9, verifiedSource: true, temporalCurrent: true }, { scopeKind: 'session', scopeId: 's', id: 'chunk-m' })
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '项目M端口是多少' }], source: { kind: 'user' } }
  const decision = await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(decision.messages.map((message) => message.source?.purpose ?? 'real-user'), ['semipersistent-snapshot', 'sensory-catalog', 'real-user'])
  assert.equal(decision.messages.slice(0, 2).every((message) => message.role === 'user' && message.source.kind === 'plugin'), true)
})

test('manual sensory storage alone does not cause automatic low-pressure retrieval', async (t) => {
  const { runtime, ledger, vectorEncoder } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  ledger.upsert('sourceSegments', {
    id: 'manual-source', sessionId: 's', state: 'sensory', replacementLineage: [],
    records: [{ seq: 1, role: 'user', sourceKind: 'user', text: '项目M端口8282' }],
  }, { scopeKind: 'session', scopeId: 's', id: 'manual-source' })
  ledger.upsert('sensoryChunks', { id: 'manual-chunk', kind: 'context-chunk', label: '项目M上下文', scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w', segmentId: 'manual-source', coreText: '项目M端口8282', contextText: '项目M端口8282', vector: vectorEncoder.encodeSync('项目M端口8282'), sourceRefs: [{ sessionId: 's', seq: 1 }], evidenceQuality: 0.9, verifiedSource: true, temporalCurrent: true }, { scopeKind: 'session', scopeId: 's', id: 'manual-chunk' })
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '项目M端口是多少' }], source: { kind: 'user' } }
  const decision = await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(decision.messages, [current])
  assert.equal(runtime.status('s', 'w').lastPreStep.retrievalSkipped, 'below-pressure-no-offloaded-context')
})

test('unchanged semipersistent snapshots are reused and changed snapshots supersede the old surface event', (t) => {
  const { semi, surface } = fixture(t)
  const s = session()
  const seg = { id: 'semi-revision', segmentId: 'semi-revision', sessionId: 's', workspaceId: 'w', label: '项目R上下文', turn: 1, sourceSeqs: [1], records: [{ seq: 1, role: 'user', text: '项目R端口是7070', blockKinds: ['text'] }], evidenceQuality: 0.9, durability: 0.9, importance: 0.9, verifiedSource: true, associations: [], state: 'semipersistent' }
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
  const { runtime, ledger } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.drainSession('s')
  assert.equal(runtime.layerCounts('s', 'w').working, 1)
  const finalized = await runtime.finalizeSession('s')
  assert.equal(finalized.transitions[0].transition, 'working-to-sensory')
  assert.equal(runtime.layerCounts('s', 'w').working, 0)
  const [parent] = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' })
  assert.equal(parent.surfaceResidency, 'labeled-pointer')
  assert.equal(parent.pointer.mode, 'labeled')
  assert.equal(typeof parent.pointer.pointerId, 'string')
  assert.equal(Number.isFinite(parent.pointer.eventSeq), true)
  assert.equal(parent.pointer.estimatedTokens > 0, true)
  assert.equal(runtime.layerCounts('s', 'w').surfaceResidency.labeledPointer > 0, true)
})

test('surface budget separates fixed floor, working history and plugin projections', () => {
  const surface = new MemorySurfaceProjector({ ledger: null, config: { effectiveInputCapTokens: 100 } })
  const budget = surface.budget({
    sessionId: 's',
    contextWindow: 1000,
    maxOutputTokens: 200,
    request: {
      system: 'system-prefix',
      tools: [{ name: 'tool-a' }],
      messages: [
        { role: 'user', content: 'old user' },
        { role: 'assistant', content: 'old assistant' },
        { role: 'user', content: 'pointer', source: { kind: 'plugin', purpose: 'sensory-checkpoint' } },
        { role: 'user', content: 'evidence', source: { kind: 'plugin', purpose: 'sensory-catalog' } },
        { role: 'user', content: 'current user' },
      ],
    },
  })
  assert.equal(budget.surfaceComponents.headerComplete, true)
  assert.equal(budget.surfaceComponents.system > 0, true)
  assert.equal(budget.surfaceComponents.tools > 0, true)
  assert.equal(budget.surfaceComponents.currentTurn > 0, true)
  assert.equal(budget.surfaceComponents.workingHistory > 0, true)
  assert.equal(budget.surfaceComponents.sensoryPointers > 0, true)
  assert.equal(budget.surfaceComponents.retrievalEvidence > 0, true)
  assert.equal(budget.fixedFloorTokens, budget.surfaceComponents.system + budget.surfaceComponents.tools + budget.surfaceComponents.currentTurn)
  assert.equal(budget.managedSurfaceTokens, budget.surfaceComponents.managedSurface)
  assert.equal(typeof budget.targetReachable, 'boolean')
})

test('default pressure target is 35 percent of usable input', () => {
  const surface = new MemorySurfaceProjector({ ledger: null, config: { effectiveInputCapTokens: 100 } })
  const budget = surface.budget({
    sessionId: 's',
    contextWindow: 1000,
    maxOutputTokens: 200,
    request: { system: '', tools: [], messages: [] },
  })
  assert.equal(surface.config.contextPressureTargetRatio, 0.35)
  assert.equal(budget.pressureTargetTokens, 35)
  assert.equal(budget.targetReachable, true)
})

test('runtime reports fixed prefix as the owner when it already exceeds the 35 percent target', async (t) => {
  const { runtime } = runtimeFixture(t, { effectiveInputCapTokens: 40 })
  const s = session()
  s.requestHeader = () => ({ system: '固定系统前缀'.repeat(20), tools: [] })
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }
  await runtime.preStep({ agent, messages: [current], turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  const outcome = runtime.status('s', 'w').pointerCompression.outcome
  assert.equal(outcome.targetRatio, 0.35)
  assert.equal(outcome.targetReached, false)
  assert.equal(outcome.reason, 'fixed-prefix-exceeds-target')
  assert.equal(outcome.nextOwner, 'dsh-native-compaction')
  assert.equal(outcome.fixedFloorTokens > outcome.targetTokens, true)
})

test('benchmark cleanup drains and drops the session without a second surface finalization', async (t) => {
  const { runtime, ledger } = fixture(t)
  const s = session()
  const agent = { cwd: 'E:/bench', session: s }
  await runtime.turnStopping({ agent, turn: 1 })
  await runtime.ledger.drain('session:s', 1000)
  assert.equal(runtime.layerCounts('s', 'w').working, 1)
  runtime.lastEvidence.set('s', { selected: ['large-session-evidence'] })
  runtime.lastTransitions.set('s', [{ transition: 'fixture' }])
  runtime.sessionAuxiliaryPurposes.set('s', { 'memory-retrieval-plan': 1 })
  runtime.frozenSessions.add('s')
  runtime.workspaceTurns.set('w', 9)
  runtime.lastPreStep = { sessionId: 's', large: 'fixture' }

  const dropped = await runtime.dropSession('s', { workspaceId: 'w', dropUniqueWorkspaceMemory: true })

  assert.equal(s.replacements.length, 0)
  assert.equal(ledger.list('sourceSegments', { scopeKind: 'session', scopeId: 's' }).length, 0)
  assert.equal(ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' }).length, 0)
  assert.equal(dropped.sessionId, 's')
  assert.equal(dropped.workspace !== null, true)
  assert.equal(runtime.sessions.has('s'), false)
  assert.equal(runtime.lastEvidence.has('s'), false)
  assert.equal(runtime.lastTransitions.has('s'), false)
  assert.equal(runtime.sessionAuxiliaryPurposes.has('s'), false)
  assert.equal(runtime.frozenSessions.has('s'), false)
  assert.equal(runtime.workspaceTurns.has('w'), false)
  assert.equal(runtime.lastPreStep, null)
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
