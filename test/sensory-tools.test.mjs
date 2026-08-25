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
