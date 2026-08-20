import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DemotionEngine, IndexSourceStore } from '../lib/demotion-engine.js'
import { ExtractionEngine } from '../lib/extraction-engine.js'
import { MatchEngine } from '../lib/match-engine.js'
import { SensoryIndex } from '../lib/sensory-index.js'
import { extractRecentTurnMessages, lastUserMessage } from '../lib/index.js'

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'sensory-demotion-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  const index = new SensoryIndex(path)
  const matcher = new MatchEngine(index)
  const demoter = new DemotionEngine({
    index,
    extractor: new ExtractionEngine(),
    sourceStore: new IndexSourceStore(index),
    matcher,
    config: { toolRounds: 3, msgRounds: 5, demoteReasoning: true },
  })
  return { path, index, matcher, demoter }
}

async function finish(demoter, turn, messages = [], queryText = '完全无关') {
  return demoter.onTurnEnd({ turn, messages, queryText, sessionId: 'session-stage2' })
}

test('tool result demotes after three subsequent unreferenced rounds', async (t) => {
  const { path, index, demoter } = fixture(t)
  await finish(demoter, 1, [{ sourceSeq: 11, role: 'tool', kind: 'tool', toolName: 'bash', text: 'RESULT: 项目A的部署端口是8081。' }])
  await finish(demoter, 2)
  await finish(demoter, 3)
  const result = await finish(demoter, 4)
  assert.equal(result.demoted, 1)
  assert.equal(index.getEntityByName('项目A').observations[0], '项目A的部署端口是8081')
  assert.ok(index.getEntityByName('端口8081'))
  assert.ok(existsSync(join(path, 'source', 'session-stage2', '11.json')))
  const rounds = JSON.parse(readFileSync(join(path, 'rounds.json'), 'utf8'))
  assert.equal(rounds.tracked[0].unrefCount, 3)
  assert.equal(rounds.tracked[0].demoted, true)
})

test('a reference resets the tool counter before the threshold', async (t) => {
  const { index, demoter } = fixture(t)
  await finish(demoter, 1, [{ sourceSeq: 12, role: 'tool', kind: 'tool', text: 'RESULT: 项目B的部署端口是9090。' }])
  await finish(demoter, 2, [], '项目B的部署端口是多少')
  assert.equal(demoter.state.tracked[0].unrefCount, 0)
  await finish(demoter, 3)
  await finish(demoter, 4)
  assert.equal(index.count(), 0)
  await finish(demoter, 5)
  assert.ok(index.getEntityByName('项目B'))
})

test('conversation messages use five rounds while reasoning demotes immediately', async (t) => {
  const { index, demoter } = fixture(t)
  const first = await finish(demoter, 1, [
    { sourceSeq: 20, role: 'assistant', kind: 'message', text: '客户#3的偏好色是color-3。' },
    { sourceSeq: 21, role: 'assistant', kind: 'reasoning', text: '项目C的部署端口是7070。' },
  ])
  assert.equal(first.demoted, 1)
  assert.ok(index.getEntityByName('项目C'))
  assert.equal(index.getEntityByName('客户#3'), null)
  for (let turn = 2; turn <= 5; turn += 1) await finish(demoter, turn)
  assert.equal(index.getEntityByName('客户#3'), null)
  await finish(demoter, 6)
  assert.ok(index.getEntityByName('客户#3'))
})

test('demotion is idempotent for one tracked source', async (t) => {
  const { index, demoter } = fixture(t)
  await finish(demoter, 1, [{ sourceSeq: 31, role: 'tool', kind: 'tool', text: 'RESULT: 项目D的部署端口是6060。' }])
  await finish(demoter, 2)
  await finish(demoter, 3)
  await finish(demoter, 4)
  const count = index.count()
  const again = await demoter.demote(demoter.state.tracked[0])
  assert.equal(again.reason, 'already-demoted')
  assert.equal(index.count(), count)
})

test('empty messages and empty text do not add tracked items or fail', async (t) => {
  const { demoter } = fixture(t)
  const first = await finish(demoter, 1, [])
  const second = await finish(demoter, 2, [{ sourceSeq: 1, role: 'assistant', text: '   ' }], '')
  assert.equal(first.tracked, 0)
  assert.equal(second.tracked, 0)
})

test('DSH-derived turn separates actual user, reasoning, nested tool result and final text', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, id: 'u1', content: [{ type: 'text', text: '执行检查' }] },
    { role: 'user', source: { kind: 'plugin' }, id: 'snapshot', content: [{ type: 'text', text: 'runtime snapshot' }] },
    { role: 'assistant', source: { kind: 'model' }, id: 'a1', content: [
      { type: 'reasoning', text: '内部推理' },
      { type: 'tool-call', id: 'call-1', name: 'pwsh' },
    ] },
    { role: 'user', source: { kind: 'tool', callId: 'call-1' }, id: 'r1', content: [
      { type: 'tool-result', content: [{ type: 'text', text: 'RESULT: 项目Z的部署端口是9191。' }] },
    ] },
    { role: 'assistant', source: { kind: 'model' }, id: 'a2', content: [{ type: 'text', text: '已完成' }] },
  ]
  const recent = extractRecentTurnMessages(messages, 1)
  assert.deepEqual(recent.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'message', text: '执行检查' },
    { kind: 'reasoning', text: '内部推理' },
    { kind: 'tool', text: 'RESULT: 项目Z的部署端口是9191。' },
    { kind: 'message', text: '已完成' },
  ])
  assert.equal(lastUserMessage(recent), '执行检查')
})
