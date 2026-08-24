import assert from 'node:assert/strict'
import test from 'node:test'

import { ContextChunker } from '../lib/context-chunker.js'
import { decomposeRetrievalQuery } from '../lib/layered-match-engine.js'
import { renderCurrentParentView } from '../lib/layered-match-support.js'
import { createVectorEncoder, FeatureHashVectorEncoder } from '../lib/vector-encoder.js'
import { runtimeFixture } from './helpers/runtime-fixture.mjs'
import { testSession } from './helpers/runtime-fixture.mjs'

function makeParent(encoder, { id, text, seq, sessionId = 's', documentTitle = id, state = 'active', evidenceQuality = 0.9 }) {
  const chunker = new ContextChunker({ parentTargetTokens: 2048, parentMaxTokens: 3072, childTargetTokens: 48, childMaxTokens: 64, childOverlapTokens: 8 })
  const draft = chunker.chunkParents(text, { segmentId: id, documentId: id, documentTitle })[0]
  const childSpans = draft.childSpans.map((child) => ({ ...child, vector: encoder.encodeSync(child.embeddingText) }))
  return {
    ...draft,
    id,
    parentId: id,
    childSpans,
    state,
    vectorState: state,
    scopeKind: 'session',
    scopeId: sessionId,
    sessionId,
    workspaceId: 'w',
    segmentId: id,
    sourceRefs: [{ sessionId, seq }],
    evidenceQuality,
    verifiedSource: true,
    temporalCurrent: true,
    updatedAt: seq,
  }
}

function put(ledger, parent) {
  ledger.upsert('sourceSegments', {
    id: parent.segmentId,
    sessionId: parent.sessionId,
    records: [{ seq: parent.sourceRefs[0].seq, role: 'user', sourceKind: 'user', text: parent.coreText }],
  }, { scopeKind: 'session', scopeId: parent.sessionId, id: parent.segmentId })
  ledger.upsert('sensoryChunks', parent, { scopeKind: 'session', scopeId: parent.sessionId, id: parent.id })
}

test('default chunker reduces a long turn to few parents while keeping multiple child views', () => {
  const text = Array.from({ length: 180 }, (_, index) => `段落${index}：系统组件${index}依赖服务${index + 1}，验证标记为TAG-${index}。`).join('\n')
  const parents = new ContextChunker().chunkParents(text, { segmentId: 'long-turn', documentId: 'doc' })
  const children = parents.flatMap((parent) => parent.childSpans)
  assert.ok(parents.length < children.length)
  assert.ok(parents.every((parent) => parent.tokenCount <= 3072))
  assert.ok(children.every((child) => child.tokenCount <= 512))
  assert.equal(new Set(children.map((child) => child.childId)).size, children.length)
})

test('deterministic decomposition keeps S0 and at most three informative clauses', () => {
  const result = decomposeRetrievalQuery('先找蓝灯塔钥匙的位置；然后确认银杏-47对应的仓库；以及项目M当前端口；还要问它')
  assert.equal(result.globalQuery.includes('蓝灯塔'), true)
  assert.ok(result.subqueries.length <= 3)
  assert.ok(result.subqueries.every((query) => query.length >= 8))
  assert.deepEqual(result.allQueries.map((query) => query.id), ['S0', ...result.subqueries.map((_, index) => `S${index + 1}`)])
})

test('multi-hop retrieval aggregates child hits and selects distinct parents for coverage', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, makeParent(vectorEncoder, { id: 'blue', seq: 1, text: '蓝灯塔档案柜钥匙位于北侧绿色箱子，校验短语是银杏-47。' }))
  put(ledger, makeParent(vectorEncoder, { id: 'port', seq: 2, text: '项目M当前部署端口为8383，发布区域是东区。' }))
  put(ledger, makeParent(vectorEncoder, { id: 'owner', seq: 3, text: '东区发布负责人是林澄，值班代号是CEDAR-9。' }))
  const result = matcher.retrieve('蓝灯塔钥匙和银杏-47在哪里；项目M当前端口是什么；东区发布负责人和CEDAR-9是谁', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.sufficient, true)
  assert.deepEqual(
    new Set(result.selected.map((parent) => parent.id)),
    new Set(['blue', 'port', 'owner']),
    JSON.stringify({ plan: result.queryPlan, candidates: result.candidates.map((parent) => ({ id: parent.id, matched: parent.matchedSubqueries, hits: parent.childHits })) }, null, 2),
  )
  assert.ok(result.generatedChildCount <= 32)
  assert.ok(result.eligibleParentCount <= 16)
  assert.ok(result.selectedParentCount <= 6)
  assert.deepEqual(result.uncoveredSubqueries, [])
})

test('pending parent and low-evidence parent remain diagnostics rather than automatic evidence', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, makeParent(vectorEncoder, { id: 'pending', seq: 1, text: '项目P端口是7001。', state: 'pending-vector' }))
  put(ledger, makeParent(vectorEncoder, { id: 'low', seq: 2, text: '项目L端口是7002。', evidenceQuality: 0.2 }))
  assert.equal(matcher.retrieve('项目P端口7001', { sessionId: 's', workspaceId: 'w' }).selected.length, 0)
  assert.equal(matcher.retrieve('项目L端口7002', { sessionId: 's', workspaceId: 'w' }).selected.length, 0)
})

test('current Parent view removes only superseded child ranges and preserves raw text', () => {
  const raw = '项目M旧端口是7001。\n项目M负责人是林澄。'
  const parent = {
    coreText: raw,
    supersededRanges: [{ startOffset: 0, endOffset: '项目M旧端口是7001。'.length }],
  }
  const current = renderCurrentParentView(parent)
  assert.doesNotMatch(current, /7001/u)
  assert.match(current, /负责人是林澄/u)
  assert.equal(parent.coreText, raw)
})

test('whole-parent budget skips an oversized parent instead of slicing it into evidence', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, makeParent(vectorEncoder, { id: 'large', seq: 1, text: `蓝灯塔 ${'完整父上下文。'.repeat(200)}` }))
  put(ledger, makeParent(vectorEncoder, { id: 'small', seq: 2, text: '项目M端口是8383。' }))
  const result = matcher.retrieve('蓝灯塔 完整父上下文；项目M端口8383', { sessionId: 's', workspaceId: 'w' })
  const catalog = matcher.renderCatalog(result.qualified, { budgetTokens: 80 })
  assert.ok(catalog)
  assert.doesNotMatch(catalog.prompt, /完整父上下文/u)
  assert.match(catalog.prompt, /8383/u)
})

test('normal configuration is explicitly lexical-only and never labels feature hash as E5', () => {
  const encoder = createVectorEncoder({})
  assert.deepEqual(encoder.status(), {
    provider: 'none', model: null, dimensions: null, calls: 0, vectorAvailable: false, lexicalOnly: true,
  })
  const prototype = new FeatureHashVectorEncoder({ dimensions: 64 })
  assert.equal(prototype.status().model, 'feature-hash-cjk-v1')
})

test('same Parent text remains isolated by session scope', (t) => {
  const { ledger, matcher, vectorEncoder } = runtimeFixture(t)
  put(ledger, makeParent(vectorEncoder, { id: 's1-parent', seq: 1, sessionId: 's1', text: '私有标记EMBER-731位于北仓。' }))
  put(ledger, makeParent(vectorEncoder, { id: 's2-parent', seq: 1, sessionId: 's2', text: '另一个标记ORBIT-204位于南仓。' }))
  assert.deepEqual(matcher.retrieve('EMBER-731 北仓', { sessionId: 's2', workspaceId: 'w' }).selected, [])
})

test('failed vectorization leaves a readable pending Parent and maintenance can activate it later', async (t) => {
  let available = false
  const fallback = new FeatureHashVectorEncoder({ dimensions: 64 })
  const vectorEncoder = {
    async encodeBatch(texts) {
      if (!available) throw new Error('sidecar offline')
      return texts.map((text) => fallback.encodeSync(text))
    },
    encodeSync(text) { return available ? fallback.encodeSync(text) : null },
    status() { return { provider: 'http', model: 'test-e5', revision: 'r1', dimensions: 64, vectorAvailable: available } },
  }
  const { runtime, ledger } = runtimeFixture(t, { vectorEncoder })
  const session = testSession({ userText: '项目M端口是8383。' })
  await assert.rejects(runtime.turnStopping({ agent: { cwd: 'E:/bench', session }, turn: 1 }), /sidecar offline/u)
  const pending = ledger.list('sourceSegments', { scopeKind: 'session', scopeId: 's' })[0]
  assert.equal(pending.contextChunks[0].state, 'pending-vector')
  available = true
  const repair = await runtime.repairPendingVectors('s')
  assert.deepEqual(repair.repaired, [pending.id])
  const active = ledger.get('sourceSegments', pending.id, { scopeKind: 'session', scopeId: 's' })
  assert.equal(active.contextChunks[0].state, 'active')
  assert.ok(active.contextChunks[0].childSpans.every((child) => child.vector?.dimensions === 64))
})
