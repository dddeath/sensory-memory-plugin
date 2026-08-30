import assert from 'node:assert/strict'
import test from 'node:test'

import { createSensoryToolDefinitions } from '../lib/sensory-tools.js'
import { runtimeFixture, storeTurn, testSession } from './helpers/runtime-fixture.mjs'

function fixture(t) {
  const services = runtimeFixture(t)
  const tools = new Map(createSensoryToolDefinitions({
    matcher: services.matcher,
    cache: services.semi,
    llmClient: null,
    runtime: services.runtime,
    ledger: services.ledger,
    bank: services.bank,
  }).map((tool) => [tool.name, tool]))
  const session = testSession()
  const exec = { turn: 2, cwd: 'E:/bench', agent: { cwd: 'E:/bench', session } }
  return { ...services, tools, session, exec }
}

test('sensory_store writes one parent for a short text and records child vector metadata', async (t) => {
  const { tools, ledger, exec } = fixture(t)
  const output = JSON.parse(await tools.get('sensory_store').execute({ text: '蓝灯塔的档案柜钥匙位于绿色盒子，验证短语是银杏-47。' }, exec))
  assert.equal(output.stored, true)
  assert.equal(output.chunkIds.length, 1)
  const stored = ledger.get('sensoryChunks', output.chunkIds[0], { scopeKind: 'session', scopeId: 's' })
  assert.equal(stored.kind, 'context-parent')
  assert.equal(stored.childSpans.length, 1)
  assert.equal(stored.vector.dimensions, 128)
  assert.equal('entities' in stored, false)
})

test('sensory_recall returns chunks and sensory_open expands the exact source', async (t) => {
  const { tools, exec } = fixture(t)
  const stored = JSON.parse(await tools.get('sensory_store').execute({ text: '蓝灯塔的档案柜钥匙位于绿色盒子，验证短语是银杏-47。' }, exec))
  const recalled = JSON.parse(await tools.get('sensory_recall').execute({ query: '蓝灯塔 档案柜钥匙 银杏-47', limit: 3 }, exec))
  assert.equal(recalled.chunks[0].chunkId, stored.chunkIds[0])
  assert.equal(recalled.chunks[0].vector.model, 'feature-hash-cjk-v1')
  const opened = JSON.parse(await tools.get('sensory_open').execute({ chunk: stored.chunkIds[0] }, exec))
  assert.equal(opened.found, true)
  assert.match(opened.coreText, /银杏-47/)
  assert.match(opened.sources[0].content.text, /银杏-47/)
})

test('sensory_recall discloses the matched child instead of the beginning of a long parent', async (t) => {
  const { tools, exec, ledger, vectorEncoder } = fixture(t)
  const beginning = `${'Guitar learning notes and practice routines. '.repeat(35)}\n`
  const target = 'I created a Spotify playlist named Summer Vibes for the beach trip.'
  const coreText = beginning + target
  const parent = {
    id: 'playlist-parent', kind: 'context-parent', label: 'long conversation parent',
    scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w', segmentId: 'playlist-source',
    coreText, contextText: coreText, documentId: 'playlist-source', documentTitle: 'conversation history',
    childSpans: [
      { childId: 'playlist-parent:child:001', startOffset: 0, endOffset: beginning.length, temporalCurrent: true, vector: vectorEncoder.encodeSync(beginning) },
      { childId: 'playlist-parent:child:002', startOffset: beginning.length, endOffset: coreText.length, temporalCurrent: true, vector: vectorEncoder.encodeSync(target) },
    ],
    sourceRefs: [{ sessionId: 's', seq: 7 }], evidenceQuality: 0.9, verifiedSource: true, temporalCurrent: true, state: 'active',
  }
  ledger.upsert('sourceSegments', { id: 'playlist-source', sessionId: 's', records: [{ seq: 7, role: 'user', sourceKind: 'user', text: coreText }] }, { scopeKind: 'session', scopeId: 's', id: 'playlist-source' })
  ledger.upsert('sensoryChunks', parent, { scopeKind: 'session', scopeId: 's', id: parent.id })
  const recalled = JSON.parse(await tools.get('sensory_recall').execute({ query: 'Spotify playlist name', limit: 3 }, exec))
  assert.equal(recalled.chunks[0].chunkId, 'playlist-parent')
  assert.match(recalled.chunks[0].excerpt, /Summer Vibes/u)
  assert.match(recalled.chunks[0].matchedChildren[0].excerpt, /Summer Vibes/u)
  assert.equal(recalled.disclosure, 'matched-child-first')
})

test('sensory_open expands the complete matched child beyond the recall excerpt', async (t) => {
  const { tools, exec, ledger, vectorEncoder } = fixture(t)
  const childText = `I need to pick up the new boots from Zara. ${'Pickup planning details. '.repeat(55)} I also need to return the old boots.`
  const parent = {
    id: 'boots-parent', kind: 'context-parent', label: 'boots errand', scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w',
    segmentId: 'boots-source', coreText: childText, contextText: childText,
    childSpans: [{ childId: 'boots-parent:child:001', startOffset: 0, endOffset: childText.length, temporalCurrent: true, vector: vectorEncoder.encodeSync(childText) }],
    sourceRefs: [{ sessionId: 's', seq: 8 }], evidenceQuality: 0.9, verifiedSource: true, temporalCurrent: true, state: 'active',
  }
  ledger.upsert('sourceSegments', { id: 'boots-source', sessionId: 's', records: [{ seq: 8, role: 'user', sourceKind: 'user', text: childText }] }, { scopeKind: 'session', scopeId: 's', id: 'boots-source' })
  ledger.upsert('sensoryChunks', parent, { scopeKind: 'session', scopeId: 's', id: parent.id })
  const recalled = JSON.parse(await tools.get('sensory_recall').execute({ query: 'pick up new boots Zara', limit: 3 }, exec))
  assert.doesNotMatch(recalled.chunks[0].excerpt, /return the old boots/u)
  const opened = JSON.parse(await tools.get('sensory_open').execute({ chunk: parent.id }, exec))
  assert.equal(opened.disclosure.mode, 'expanded-matched-child')
  assert.match(opened.coreText, /return the old boots/u)
})

test('retrieval convergence suppresses duplicate evidence and duplicate parent opens', async (t) => {
  const { tools, exec } = fixture(t)
  const stored = JSON.parse(await tools.get('sensory_store').execute({ text: '蓝灯塔钥匙在绿色盒子里，短语是银杏-47。' }, exec))
  const first = JSON.parse(await tools.get('sensory_recall').execute({ query: '蓝灯塔 钥匙', limit: 3 }, exec))
  assert.equal(first.convergence.reason, 'new-evidence')
  const duplicate = JSON.parse(await tools.get('sensory_recall').execute({ query: '  蓝灯塔   钥匙  ', limit: 3 }, exec))
  assert.equal(duplicate.converged, true)
  assert.equal(duplicate.reason, 'duplicate-query')
  const opened = JSON.parse(await tools.get('sensory_open').execute({ chunk: stored.chunkIds[0] }, exec))
  assert.equal(opened.found, true)
  const duplicateOpen = JSON.parse(await tools.get('sensory_open').execute({ chunk: stored.chunkIds[0] }, exec))
  assert.equal(duplicateOpen.converged, true)
  assert.equal(duplicateOpen.reason, 'duplicate-parent-open')
})

test('sensory_open returns a bounded disclosure for a large parent', async (t) => {
  const { tools, exec, ledger } = fixture(t)
  const coreText = `大型上下文开始。${'完整记录内容。'.repeat(2200)}目标标记END-731。`
  ledger.upsert('sourceSegments', { id: 'large-source', sessionId: 's', records: [{ seq: 9, role: 'user', sourceKind: 'user', text: coreText }] }, { scopeKind: 'session', scopeId: 's', id: 'large-source' })
  ledger.upsert('sensoryChunks', {
    id: 'large-parent', kind: 'context-parent', label: 'large', scopeKind: 'session', scopeId: 's', sessionId: 's', workspaceId: 'w',
    segmentId: 'large-source', coreText, contextText: coreText, sourceRefs: [{ sessionId: 's', seq: 9 }], evidenceQuality: 0.9,
    verifiedSource: true, temporalCurrent: true, state: 'active',
  }, { scopeKind: 'session', scopeId: 's', id: 'large-parent' })
  const opened = JSON.parse(await tools.get('sensory_open').execute({ chunk: 'large-parent' }, exec))
  assert.equal(opened.found, true)
  assert.equal(opened.coreText.length <= 6001, true)
  assert.equal(opened.disclosure.mode, 'bounded-parent-view')
  assert.equal(opened.disclosure.truncated, true)
})

test('sensory_demote replaces one tracked segment and persists chunk IDs', async (t) => {
  const { tools, runtime, ledger, session, exec } = fixture(t)
  await storeTurn(runtime, session, 1)
  const output = JSON.parse(await tools.get('sensory_demote').execute({ sourceSeq: 1 }, exec))
  assert.equal(output.demoted, true)
  assert.equal(output.chunkIds.length >= 1, true)
  assert.equal(ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' }).length >= 1, true)
})

test('sensory_status reports parent-child layer counts and vector encoder state', async (t) => {
  const { tools, exec } = fixture(t)
  await tools.get('sensory_store').execute({ text: '项目M当前部署端口是8383。' }, exec)
  const status = JSON.parse(await tools.get('sensory_status').execute({}, exec))
  assert.equal(status.architecture, 'parent-child-vector-v2')
  assert.equal(status.layerCounts.sensoryChunks, 1)
  assert.equal(status.vectorEncoder.model, 'feature-hash-cjk-v1')
  assert.equal(status.matcher.architecture, 'parent-child-vector-v2')
})

test('explicit update supersedes an older similar chunk without creating a fact record', async (t) => {
  const { tools, exec, session, ledger } = fixture(t)
  const old = JSON.parse(await tools.get('sensory_store').execute({ text: '项目M当前部署端口是8282。' }, exec))
  session.events.push({ seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: 'update boundary' } } })
  const current = JSON.parse(await tools.get('sensory_store').execute({ text: '项目M当前部署端口更新为8383。' }, exec))
  const oldChunk = ledger.get('sensoryChunks', old.chunkIds[0], { scopeKind: 'session', scopeId: 's' })
  const newChunk = ledger.get('sensoryChunks', current.chunkIds[0], { scopeKind: 'session', scopeId: 's' })
  assert.equal(oldChunk.temporalCurrent, false)
  assert.equal(oldChunk.supersededBy, newChunk.id)
  assert.deepEqual(newChunk.supersedes, [`${oldChunk.id}:child:001`])
  assert.equal('canonicalFacts' in newChunk, false)
})

test('a long technical document mentioning current state does not supersede prior memory', async (t) => {
  const { tools, exec, ledger } = fixture(t)
  const old = JSON.parse(await tools.get('sensory_store').execute({ text: '项目M当前部署端口是8282。' }, exec))
  const longTechnicalText = `--- document survey ---\n${'This survey explains that the current system is evaluated with project M deployment terminology, but it does not issue a configuration update. '.repeat(12)}`
  await tools.get('sensory_store').execute({ text: longTechnicalText }, exec)
  const oldChunk = ledger.get('sensoryChunks', old.chunkIds[0], { scopeKind: 'session', scopeId: 's' })
  assert.equal(oldChunk.temporalCurrent, true)
  assert.equal(oldChunk.supersededBy, null)
})

test('tool schemas expose chunk rather than entity parameters', (t) => {
  const { tools } = fixture(t)
  assert.deepEqual(Object.keys(tools.get('sensory_open').parameters.properties), ['chunk'])
  assert.equal(tools.has('sensory_audit'), false)
})

test('retrieval-only tool mode exposes only sensory_recall and sensory_open', () => {
  const tools = createSensoryToolDefinitions({
    matcher: { scopeFor: () => 's' },
    toolMode: 'retrieval-only',
  })
  assert.deepEqual(tools.map((tool) => tool.name), ['sensory_recall', 'sensory_open'])
})

test('retrieval-only benchmark budget returns one recall result and then asks the model to answer', async () => {
  let calls = 0
  const tools = createSensoryToolDefinitions({
    toolMode: 'retrieval-only',
    retrievalToolCallLimit: 1,
    matcher: {},
    runtime: {
      config: { userGlobalEnabled: false },
      async workspace() { return { workspaceId: 'w' } },
      matcher: {
        async retrieveAsync() { calls += 1; return { candidates: [] } },
      },
    },
  })
  const recall = tools.find((tool) => tool.name === 'sensory_recall')
  const exec = { turn: 1, agent: { session: { id: 's' } } }
  assert.match(await recall.execute({ query: 'first' }, exec), /"chunks": \[\]/)
  assert.match(await recall.execute({ query: 'second' }, exec), /"budgetExceeded": true/)
  assert.equal(calls, 1)
})

test('compression-only tool mode exposes no memory tools', () => {
  const tools = createSensoryToolDefinitions({
    matcher: { scopeFor: () => 's' },
    toolMode: 'compression-only',
  })
  assert.deepEqual(tools, [])
})
