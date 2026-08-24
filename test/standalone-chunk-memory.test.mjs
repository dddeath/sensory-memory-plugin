import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { StandaloneChunkMemory } from '../lib/standalone-chunk-memory.js'

function fixture(t, sessionId = 'memgym-s1', config = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'standalone-chunk-memory-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  return new StandaloneChunkMemory({ rootDir, sessionId, workspaceId: 'memgym', maxTokens: 2_000, config })
}

test('standalone manager demotes the prior turn and retrieves verified source chunks', async (t) => {
  const memory = fixture(t)
  await memory.manageContext({
    currentObservation: '蓝灯塔档案：档案柜钥匙位于北侧窗台下方的绿色箱子，校验短语是银杏-47。',
    metadata: { question: '蓝灯塔钥匙和校验短语是什么？' },
  })
  const second = await memory.manageContext({
    currentObservation: '第二轮只包含无关的天气记录。',
    metadata: { question: '蓝灯塔钥匙和银杏-47在哪里？' },
  })

  assert.equal(second.metadata.transitionCount, 1)
  assert.ok(second.metadata.retrievedChunkIds.length >= 1)
  assert.match(second.content.join('\n'), /北侧窗台下方的绿色箱子/u)
  assert.match(second.content.join('\n'), /银杏-47/u)
  assert.ok(second.metadata.sourceRefs.every((ref) => ref.sessionId === 'memgym-s1'))
  assert.ok(second.metadata.tokens <= 2_000)
  assert.equal(memory.stats().layerCounts.sensory > 0, true)
  assert.equal(memory.close().closed, true)
})

test('standalone manager keeps session sensory isolated', async (t) => {
  const left = fixture(t, 'left')
  const right = fixture(t, 'right')
  await left.manageContext({ currentObservation: '孤立标记是EMBER-731，部署槽位为北仓。', metadata: { question: 'EMBER-731' } })
  await left.manageContext({ currentObservation: '推进到下一轮。', metadata: { question: 'EMBER-731' } })
  const hidden = await right.retrieve('EMBER-731 北仓')
  assert.equal(hidden.selected.length, 0)
})

test('standalone manager applies temporal supersession before retrieval', async (t) => {
  const memory = fixture(t, 'temporal')
  await memory.manageContext({ currentObservation: '海蓝服务当前部署端口为7001，服务区域为东区。', metadata: { question: '海蓝服务端口' } })
  await memory.manageContext({ currentObservation: '海蓝服务部署端口更新为7002，服务区域仍为东区。', metadata: { question: '海蓝服务端口' } })
  await memory.manageContext({ currentObservation: '请核对最新配置。', metadata: { question: '海蓝服务当前部署端口' } })
  const sensory = memory.ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 'temporal' })
  assert.ok(sensory.some((chunk) => chunk.temporalCurrent === false && chunk.supersededBy))
  const latest = await memory.retrieve('海蓝服务当前部署端口')
  assert.doesNotMatch(latest.notes, /7001/u)
  assert.match(latest.notes, /7002/u)
})

