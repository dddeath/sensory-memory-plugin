import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LLMExtractor } from '../lib/llm-extractor.js'
import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensory-refine-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new SensoryIndex(dir)
}

test('LLMExtractor removes RESULT and m generic noise', async (t) => {
  const index = fixture(t)
  const ids = [
    index.addEntity({ name: 'RESULT' }),
    index.addEntity({ name: 'm' }),
    index.addEntity({ name: '项目M', observations: ['项目M的端口是8282'] }),
  ]
  const llm = { complete: async () => ({
    noise: ['RESULT', 'm'],
    entities: [{ name: '项目M', type: 'project', observations: ['项目M的端口是8282'] }],
  }) }
  const result = await new LLMExtractor({ llm, index }).refine({ entityIds: ids, text: 'RESULT 项目M的端口是8282 m' })
  assert.equal(result.refined, true)
  assert.equal(index.getEntityByName('RESULT'), null)
  assert.equal(index.getEntityByName('m'), null)
  assert.ok(index.getEntityByName('项目M'))
})

test('LLMExtractor merges aliases into one canonical entity and indexes each alias', async (t) => {
  const index = fixture(t)
  const first = index.addEntity({ name: '客户#3', observations: ['客户#3偏好蓝色'] })
  const second = index.addEntity({ name: '客户三号', observations: ['客户三号偏好蓝色'] })
  const llm = { complete: async () => JSON.stringify({
    entities: [{
      name: '客户#3', type: 'person', aliases: ['客户三号'], mergeFrom: ['客户三号'],
      observations: ['客户#3偏好蓝色'],
    }],
  }) }
  await new LLMExtractor({ llm, index }).refine({ entityIds: [first, second], text: '客户三号就是客户#3' })
  assert.equal(index.count(), 1)
  assert.equal(index.getEntityByName('客户三号').name, '客户#3')
  assert.deepEqual(index.getEntityByName('客户#3').aliases, ['客户三号'])
})

test('LLM confirmed entities receive 0.9 while rule-only entities remain 0.6', async (t) => {
  const index = fixture(t)
  const confirmedId = index.addEntity({ name: '项目A', observations: ['项目A的端口是8081'] })
  const ruleId = index.addEntity({ name: '项目B', observations: ['项目B的端口是8082'] })
  const llm = { complete: async () => ({ entities: [{ name: '项目A', type: 'project' }] }) }
  await new LLMExtractor({ llm, index }).refine({ entityIds: [confirmedId], text: '项目A的端口是8081' })
  await new LLMExtractor({ llm: null, index }).refine({ entityIds: [ruleId], text: '项目B的端口是8082' })
  assert.equal(index.get(confirmedId).confidence, 0.9)
  assert.equal(index.get(ruleId).confidence, 0.6)
})

test('LLM failure falls back to the rule result without throwing', async (t) => {
  const index = fixture(t)
  const id = index.addEntity({ name: '项目C', observations: ['项目C的端口是8083'] })
  const extractor = new LLMExtractor({ llm: { complete: async () => { throw new Error('mock offline') } }, index })
  const result = await extractor.refine({ entityIds: [id], text: '项目C的端口是8083' })
  assert.equal(result.refined, false)
  assert.equal(result.fallback, 'rule')
  assert.equal(index.get(id).confidence, 0.6)
  assert.match(result.error, /mock offline/)
})

test('LLM empty entity list is a successful rejection of rule-only false facts', async (t) => {
  const index = fixture(t)
  const id = index.addEntity({ name: '项目R', observations: ['项目R的端口是8585'] })
  const extractor = new LLMExtractor({ llm: { complete: async () => ({ entities: [] }) }, index })
  const result = await extractor.refine({ entityIds: [id], text: '请只输出项目R的端口是8585' })
  assert.equal(result.refined, true)
  assert.equal(result.rejectedAll, true)
  assert.equal(index.get(id), null)
})
