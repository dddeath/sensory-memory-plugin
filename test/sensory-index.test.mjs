import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'sensory-index-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function parseJsonl(path) {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
}

test('addEntity and getEntityByName hit the title index', (t) => {
  const index = new SensoryIndex(fixture(t))
  const id = index.addEntity({
    name: '客户#3',
    entityType: 'person',
    observations: ['偏好色是color-3'],
    sourceRef: { sessionId: 'session-abc', seq: 1234 },
    keywords: ['客户', '偏好', 'color'],
  })
  assert.equal(index.getEntityByName('客户#3').id, id)
  assert.equal(index.count(), 1)
})

test('same-name add updates in place and appends observations/source refs', (t) => {
  const index = new SensoryIndex(fixture(t))
  const first = index.addEntity({
    name: '客户#3', entityType: 'person', observations: ['偏好color-3'], sourceRef: { sessionId: 's', seq: 1 }, confidence: 0.5,
  })
  const second = index.addEntity({
    name: '客户#3', observations: ['偏好color-5'], sourceRef: { sessionId: 's', seq: 2 }, confidence: 0.8,
  })
  const entity = index.get(first)
  assert.equal(second, first)
  assert.equal(entity.entityType, 'person')
  assert.deepEqual(entity.observations, ['偏好color-3', '偏好color-5'])
  assert.equal(entity.confidence, 0.8)
  assert.equal(entity.source_refs.length, 2)
  assert.equal(entity.valid_to, null)
})

test('conflicting temporal observations coexist with distinct valid_from values', (t) => {
  const path = fixture(t)
  const index = new SensoryIndex(path)
  index.addEntity({ name: '客户#3', observations: ['偏好color-3'], sourceRef: { sessionId: 's', seq: 1 } })
  index.addEntity({ name: '客户#3', observations: ['偏好color-5'], sourceRef: { sessionId: 's', seq: 2 } })
  index.flush()
  const observations = parseJsonl(join(path, 'observations.jsonl'))
  assert.equal(observations.length, 2)
  assert.notEqual(observations[0].valid_from, observations[1].valid_from)
  assert.deepEqual(observations.map((item) => item.valid_to), [null, null])
  assert.deepEqual(observations.map((item) => item.contents[0]), ['偏好color-3', '偏好color-5'])
})

test('lookup merges title, token and reused n-gram hash candidates', (t) => {
  const index = new SensoryIndex(fixture(t))
  const id = index.addEntity({
    name: '项目A',
    entityType: 'project',
    observations: ['项目A的部署端口是8081'],
    keywords: ['部署端口'],
  })
  assert.equal(index.lookup('项目A')[0].id, id)
  assert.ok(index.lookup('8081').some((entity) => entity.id === id))
  assert.ok(index.lookup('部署端口').some((entity) => entity.id === id))
})

test('flush restores entities, relations, observations, source text and rounds shape', (t) => {
  const path = fixture(t)
  const index = new SensoryIndex(path)
  const sourceRef = { sessionId: 'session-abc', seq: 1234 }
  const customer = index.addEntity({ name: '客户#3', entityType: 'person', observations: ['偏好color-3'], sourceRef })
  const project = index.addEntity({ name: '项目A', entityType: 'project', sourceRef })
  const relation = index.addRelation({ from: customer, to: project, relationType: 'uses', sourceRef })
  index.addObservation({ entityId: project, content: '项目A的部署端口是8081', sourceRef })
  const sourcePath = index.writeSource(sourceRef, { role: 'tool', text: 'RESULT: 项目A的部署端口是8081' })
  index.flush()

  const restored = new SensoryIndex(path)
  assert.equal(restored.count(), 2)
  assert.equal(restored.get(relation).relationType, 'uses')
  assert.equal(restored.getEntityByName('项目A').observations[0], '项目A的部署端口是8081')
  assert.deepEqual(restored.readSource(sourceRef), { role: 'tool', text: 'RESULT: 项目A的部署端口是8081' })
  assert.ok(existsSync(sourcePath))
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'rounds.json'), 'utf8')), { tracked: [] })
})

test('atomic flush leaves only complete JSONL files and no temporary half-files', (t) => {
  const path = fixture(t)
  const index = new SensoryIndex(path)
  for (let value = 0; value < 25; value += 1) {
    index.addEntity({ name: `项目${String.fromCharCode(65 + value)}`, observations: [`版本是${value}`] })
  }
  index.flush()
  index.addEntity({ name: '客户#3', observations: ['偏好color-3'] })
  index.flush()

  const files = readdirSync(path)
  assert.equal(files.some((file) => file.includes('.tmp-')), false)
  for (const file of ['entities.jsonl', 'relations.jsonl', 'observations.jsonl']) {
    assert.doesNotThrow(() => parseJsonl(join(path, file)))
  }
  assert.equal(parseJsonl(join(path, 'entities.jsonl')).length, 26)
})

test('persisted records satisfy the stage-1 JSONL schemas', (t) => {
  const path = fixture(t)
  const index = new SensoryIndex(path)
  const ref = { sessionId: 'schema-session', seq: 9 }
  const left = index.addEntity({ name: '客户#3', entityType: 'person', observations: ['偏好color-3'], keywords: ['客户'], sourceRef: ref })
  const right = index.addEntity({ name: '项目A', entityType: 'project', sourceRef: ref })
  index.addRelation({ from: left, to: right, relationType: 'assigned_to', sourceRef: ref })
  index.flush()

  const [entity] = parseJsonl(join(path, 'entities.jsonl'))
  const [relation] = parseJsonl(join(path, 'relations.jsonl'))
  const [observation] = parseJsonl(join(path, 'observations.jsonl'))
  assert.deepEqual(Object.keys(entity), [
    'type', 'id', 'name', 'entityType', 'observations', 'valid_from', 'valid_to', 'confidence',
    'source_refs', 'keywords', 'demote_at', 'hit_count', 'last_hit_at',
  ])
  assert.match(entity.id, /^e_[0-9a-f-]+$/)
  assert.equal(relation.type, 'relation')
  assert.match(relation.id, /^r_[0-9a-f-]+$/)
  assert.equal(observation.type, 'observation')
  assert.match(observation.id, /^o_[0-9a-f-]+$/)
  assert.deepEqual(observation.contents, ['偏好color-3'])
})
