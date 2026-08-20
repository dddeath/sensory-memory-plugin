import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DemotionEngine, IndexSourceStore } from '../lib/demotion-engine.js'
import { ExtractionEngine } from '../lib/extraction-engine.js'
import { MatchEngine } from '../lib/match-engine.js'
import { SensoryIndex } from '../lib/sensory-index.js'
import { createSensoryToolDefinitions } from '../lib/sensory-tools.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensory-tools-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const index = new SensoryIndex(dir)
  const extractor = new ExtractionEngine()
  const matcher = new MatchEngine(index)
  const sourceStore = new IndexSourceStore(index)
  const demoter = new DemotionEngine({ index, extractor, matcher, sourceStore })
  const tools = new Map(createSensoryToolDefinitions({ index, matcher, extractor, sourceStore, demoter })
    .map((tool) => [tool.name, tool]))
  return { index, extractor, matcher, sourceStore, demoter, tools }
}

test('sensory_recall returns candidate entities and observations', async (t) => {
  const { index, matcher, tools } = fixture(t)
  index.addEntity({
    name: '客户#3', observations: ['客户#3的偏好色是color-3'], keywords: ['客户', 'color-3'],
    sourceRef: { sessionId: 's', seq: 3 },
  })
  index.flush()
  matcher.markDirty()
  const output = JSON.parse(await tools.get('sensory_recall').execute({ query: '客户#3', limit: 3 }))
  assert.equal(output.candidates[0].entity, '客户#3')
  assert.deepEqual(output.candidates[0].observations, ['客户#3的偏好色是color-3'])
})

test('sensory_open expands the indexed source text', async (t) => {
  const { index, tools } = fixture(t)
  const sourceRef = { sessionId: 's', seq: 9 }
  index.addEntity({ name: '项目A', observations: ['项目A的部署端口是8081'], sourceRef })
  index.writeSource(sourceRef, { text: '原文：项目A的部署端口是8081。' })
  const output = JSON.parse(await tools.get('sensory_open').execute({ entity: '[[项目A]]' }))
  assert.equal(output.found, true)
  assert.equal(output.sources[0].content.text, '原文：项目A的部署端口是8081。')
})

test('sensory_store extracts and persists new entities', async (t) => {
  const { index, tools } = fixture(t)
  const output = JSON.parse(await tools.get('sensory_store').execute({ text: '请记住项目M的部署端口是8282。' }))
  assert.equal(output.stored, true)
  assert.ok(output.entityIds.length >= 1)
  assert.equal(index.getEntityByName('项目M').observations[0], '项目M的部署端口是8282')
})

test('sensory_demote marks the selected round and adds it to the index', async (t) => {
  const { index, demoter, tools } = fixture(t)
  await demoter.onTurnEnd({
    turn: 1,
    sessionId: 's',
    messages: [{ sourceSeq: 42, role: 'assistant', kind: 'message', text: '项目D的部署端口是6060。' }],
  })
  const output = JSON.parse(await tools.get('sensory_demote').execute({ sourceSeq: 42 }))
  assert.equal(output.demoted, true)
  assert.equal(demoter.state.tracked.find((item) => item.sourceSeq === 42).demoted, true)
  assert.ok(index.getEntityByName('项目D'))
})

test('sensory_status returns all required statistics', async (t) => {
  const { index, demoter, tools } = fixture(t)
  index.addEntity({ name: '客户#1', observations: ['客户#1的偏好色是blue'] })
  await demoter.onTurnEnd({ turn: 1, sessionId: 's', messages: [] })
  const output = JSON.parse(await tools.get('sensory_status').execute({}))
  assert.deepEqual(Object.keys(output), [
    'entityCount', 'relationCount', 'observationCount', 'roundsTracked', 'lastDemoted', 'lastInjection',
  ])
  assert.equal(output.entityCount, 1)
  assert.equal(output.observationCount, 1)
  assert.equal(output.lastInjection, null)
})
