import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryRetrievalPlanner } from '../lib/memory-retrieval-planner.js'
import { runtimeFixture } from './helpers/runtime-fixture.mjs'

function chunk(encoder, { id, sessionId = 's', segmentId = id, text, seq = 1, evidenceQuality = 0.9, updatedAt = 1 }) {
  return {
    id,
    kind: 'context-chunk',
    scopeKind: 'session',
    scopeId: sessionId,
    sessionId,
    workspaceId: 'w',
    segmentId,
    label: id,
    coreText: text,
    contextText: text,
    vector: encoder.encodeSync(text),
    sourceRefs: [{ sessionId, seq }],
    evidenceQuality,
    verifiedSource: true,
    temporalCurrent: true,
    updatedAt,
  }
}

function put(ledger, value, sourceText = value.coreText) {
  ledger.upsert('sourceSegments', {
    id: value.segmentId,
    sessionId: value.sessionId,
    records: [{ seq: value.sourceRefs[0].seq, role: 'user', sourceKind: 'user', text: sourceText }],
  }, { scopeKind: 'session', scopeId: value.sessionId, id: value.segmentId })
  ledger.upsert('sensoryChunks', value, { scopeKind: 'session', scopeId: value.sessionId, id: value.id })
}

test('chunk matcher is session-scoped and returns one qualified chunk for direct content', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'blue', sessionId: 's1', text: '蓝灯塔的档案柜钥匙在绿色盒子里，验证短语是银杏-47。' }))
  put(ledger, chunk(vectorEncoder, { id: 'other', sessionId: 's2', text: '蓝灯塔钥匙在红色抽屉里。' }))
  const result = matcher.retrieve('蓝灯塔 档案柜钥匙 银杏-47', { sessionId: 's1', workspaceId: 'w' })
  assert.equal(result.selected[0].id, 'blue')
  assert.deepEqual(result.candidates.map((item) => item.id), ['blue'])
  assert.equal(result.selected[0].sourceValidation.reason, 'source-chunk-verified')
})

test('empty candidates stay zero-injection and do not call the planner', async (t) => {
  const { matcher } = runtimeFixture(t)
  const result = matcher.retrieve('完全没有保存过的主题', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.candidates.length, 0)
  assert.equal(result.needsPlanner, false)
  const planner = new MemoryRetrievalPlanner({ matcher, llm: { async complete() { throw new Error('must not run') } } })
  assert.equal(await planner.plan(result, { sessionId: 's', turn: 1, step: 1 }), null)
  assert.equal(planner.status().llmCalls, 0)
})

test('HTTP vector failure is reported as lexical-fallback instead of silent hybrid retrieval', async (t) => {
  const vectorEncoder = {
    provider: 'http',
    encodeSync() { return null },
    async encodeBatch(texts) { return texts.map(() => null) },
    status() { return { provider: 'http', vectorAvailable: false, failures: 1, lastError: 'sidecar unavailable' } },
  }
  const { ledger, matcher } = runtimeFixture(t, { vectorEncoder })
  put(ledger, chunk(vectorEncoder, { id: 'lexical-fallback', text: '项目M当前部署端口是8282。' }))
  const result = await matcher.retrieveAsync('项目M当前部署端口8282', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.retrievalMode, 'lexical-fallback')
  assert.equal(result.vectorAvailable, false)
  assert.equal(result.degraded, true)
  assert.equal(result.degradationReason, 'sidecar unavailable')
  assert.equal(matcher.status().lexicalFallbackQueries, 1)
})

test('an ordinary weak vector candidate does not trigger a retrieval-plan call', async (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'old-terminal', text: '终端历史记录包含 package 配置。' }))
  const result = matcher.retrieve('请继续执行当前终端任务', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.sufficient, false)
  assert.equal(result.needsPlanner, false)
  const planner = new MemoryRetrievalPlanner({ matcher, llm: { async complete() { throw new Error('must not run') } } })
  assert.equal(await planner.plan(result, { sessionId: 's', turn: 2 }), null)
})

test('a unique current chunk does not call planner merely because query says current', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'current', text: '项目M当前部署端口是8383。' }))
  const result = matcher.retrieve('项目M当前部署端口', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.sufficient, true)
  assert.equal(result.needsPlanner, false)
  assert.deepEqual(result.selected.map((item) => item.id), ['current'])
})

test('coreference uses one compact planner call per user turn and rejects invented IDs', async (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'blue', text: '蓝灯塔的档案柜钥匙在绿色盒子里。' }))
  const result = matcher.retrieve('上次那个钥匙在哪里', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.needsPlanner, true)
  let calls = 0
  const llm = {
    async complete(_prompt, options) {
      calls += 1
      assert.equal(options.reasoningEffort, 'off')
      return JSON.stringify({ resolvedQuery: '蓝灯塔 档案柜钥匙 绿色盒子', chunkHints: ['蓝灯塔'], selectedCandidateIds: ['invented', 'blue'], needOpen: true, confidence: 0.8 })
    },
  }
  const planner = new MemoryRetrievalPlanner({ matcher, llm })
  const first = await planner.plan(result, { sessionId: 's', turn: 2, step: 1, taskStateRevision: 1 })
  const second = await planner.plan(result, { sessionId: 's', turn: 2, step: 2, taskStateRevision: 1 })
  assert.equal(first.verified, true)
  assert.deepEqual(first.selected.map((item) => item.id), ['blue'])
  assert.equal(second, null)
  assert.equal(calls, 1)
})

test('source mismatch and low evidence quality keep chunks out of automatic evidence', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'mismatch', text: '项目M部署端口是8282。' }), '完全无关的原始消息')
  put(ledger, chunk(vectorEncoder, { id: 'low', text: '项目N部署端口是8383。', evidenceQuality: 0.4, seq: 2 }))
  assert.equal(matcher.retrieve('项目M部署端口', { sessionId: 's', workspaceId: 'w' }).selected.length, 0)
  assert.equal(matcher.retrieve('项目N部署端口', { sessionId: 's', workspaceId: 'w' }).selected.length, 0)
})

test('catalog renders chunk IDs, excerpts and source seq instead of entities', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, chunk(vectorEncoder, { id: 'blue', text: '蓝灯塔的档案柜钥匙在绿色盒子里。', seq: 9 }))
  const result = matcher.retrieve('蓝灯塔 档案柜钥匙 绿色盒子', { sessionId: 's', workspaceId: 'w' })
  const catalog = matcher.renderCatalog(result.selected)
  assert.match(catalog.prompt, /\[\[chunk:blue\]\]/)
  assert.match(catalog.prompt, /\[seq 9-9\]/)
  assert.doesNotMatch(catalog.prompt, /实体|canonical/)
})
