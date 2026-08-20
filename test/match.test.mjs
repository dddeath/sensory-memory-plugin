import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adaptSensoryIndex } from '../lib/engram-adapter.js'
import { MatchEngine } from '../lib/match-engine.js'
import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'sensory-match-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const index = new SensoryIndex(path)
  const customer = index.addEntity({
    name: '客户#3',
    entityType: 'person',
    observations: ['客户#3的偏好色是color-3'],
    keywords: ['客户', '偏好色', 'color-3'],
  })
  const project = index.addEntity({
    name: '项目A',
    entityType: 'project',
    observations: ['项目A的部署端口是8081'],
    keywords: ['项目', '部署', '部署端口', '8081'],
  })
  const port = index.addEntity({
    name: '端口8081',
    observations: ['端口8081用于项目A部署'],
    keywords: ['端口', '8081', '部署'],
  })
  return { index, ids: { customer, project, port } }
}

test('engram adapter exposes node-returning lookup/get/all/count and touch', (t) => {
  const { index, ids } = fixture(t)
  const store = adaptSensoryIndex(index)
  assert.equal(store.count(), 3)
  assert.equal(store.all().length, 3)
  assert.equal(store.get(ids.customer).title, '客户#3')
  assert.equal(store.byTitle('项目A').id, ids.project)
  assert.ok(store.lookup('项目A部署', 4).some((node) => node.id === ids.project))
  assert.equal(store.get(ids.customer).hits, 0)
  store.touch(ids.customer)
  assert.equal(store.get(ids.customer).hits, 1)
})

test('gold queries achieve hit@1 >= 60 percent including the expected null', async (t) => {
  const { index } = fixture(t)
  const matcher = new MatchEngine(index)
  const gold = [
    { query: '客户#3喜欢什么颜色', expected: '客户#3' },
    { query: '项目A部署在哪个端口', expected: '项目A' },
    { query: '部署有什么坑', expected: new Set(['端口8081', '项目A']) },
    { query: '天气怎么样', expected: null },
  ]
  let correct = 0
  for (const item of gold) {
    const result = await matcher.match(item.query)
    const top = result.engrams[0]?.name ?? null
    if (item.expected instanceof Set ? item.expected.has(top) : top === item.expected) correct += 1
  }
  const hitAt1 = correct / gold.length
  assert.ok(hitAt1 >= 0.6, `hit@1=${hitAt1}`)
  assert.equal(hitAt1, 1)
})

test('unrelated query returns no hash candidate', async (t) => {
  const { index } = fixture(t)
  const result = await new MatchEngine(index).match('天气怎么样')
  assert.deepEqual(result.engrams, [])
  assert.equal(result.reason, 'no-hash-hit')
})

test('vendored SemanticScorer ranks the correct project first among candidates', async (t) => {
  const { index } = fixture(t)
  index.addEntity({
    name: '项目B',
    entityType: 'project',
    observations: ['项目B的测试端口是9000'],
    keywords: ['项目', '测试', '端口'],
  })
  const result = await new MatchEngine(index).match('项目A部署在哪个端口')
  assert.equal(result.engrams[0].name, '项目A')
})

test('sync fast path keeps an exact entity anchor isolated from generic project overlap', (t) => {
  const { index } = fixture(t)
  index.addEntity({
    name: '项目M',
    entityType: 'project',
    observations: ['项目M的部署端口是8282'],
    keywords: ['项目', '部署', '部署端口', '8282'],
  })
  const result = new MatchEngine(index).matchSync('项目M 部署端口')
  assert.deepEqual(result.engrams.map((entity) => entity.name), ['项目M'])
})

test('MatchEngine output retains every selected stage-1 lookup candidate', async (t) => {
  const { index } = fixture(t)
  const query = '项目A部署端口8081'
  const directIds = new Set(index.lookup(query, 3).map((entity) => entity.id))
  const result = await new MatchEngine(index, { maxWakePerTurn: 3 }).match(query)
  const matchedIds = new Set(result.engrams.map((entity) => entity.id))
  assert.ok([...directIds].every((id) => matchedIds.has(id)))
})
