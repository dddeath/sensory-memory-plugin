import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryBank } from '../lib/memory-bank.js'
import { MemoryLedger } from '../lib/memory-ledger.js'
import { MemoryPolicy } from '../lib/memory-policy.js'
import { SemipersistentLayer } from '../lib/semipersistent-layer.js'
import { ContextChunker } from '../lib/context-chunker.js'
import { FeatureHashVectorEncoder } from '../lib/vector-encoder.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'semi-bank-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(dir)
  const policy = new MemoryPolicy()
  const semi = new SemipersistentLayer({ ledger, policy })
  const chunker = new ContextChunker()
  const vectorEncoder = new FeatureHashVectorEncoder({ dimensions: 64 })
  const bank = new MemoryBank({ ledger, semipersistentLayer: semi, chunker, vectorEncoder })
  return { ledger, policy, semi, bank }
}

function segment() {
  return { id: 'seg1', segmentId: 'seg1', sessionId: 'source', workspaceId: 'w', label: '蓝灯塔', turn: 1, sourceSeqs: [1, 2, 3], records: [
    { seq: 1, role: 'user', text: '档案柜钥匙在绿色箱子里', blockKinds: ['text'] },
    { seq: 2, role: 'assistant', text: 'reasoning and debug', blockKinds: ['reasoning'] },
    { seq: 3, role: 'tool', toolName: 'debug', text: 'full tool log', blockKinds: ['tool-result'] },
  ], evidenceQuality: 0.9, durability: 0.9, importance: 0.9, verifiedSource: true, associations: [], createdAt: Date.now(), updatedAt: Date.now() }
}

test('workspace semipersistent records create zero-association references and only promoted sessions get full projection', (t) => {
  const { semi } = fixture(t)
  semi.promote(segment(), { workspaceId: 'w', sessionId: 'source', workspaceTurn: 1 })
  const sync = semi.syncSessionReferences('target', 'w')
  assert.equal(sync.created, 1)
  assert.equal(semi.projection('seg1', 'target').state, 'reference')
  assert.equal(semi.projection('seg1', 'target').associationWeight, 0)
  assert.equal(semi.renderSnapshot('target', 'w'), null)
  semi.promoteProjection('seg1', 'target', 'w')
  const snapshot = semi.renderSnapshot('target', 'w', { budgetTokens: 500 })
  assert.match(snapshot.prompt, /档案柜钥匙在绿色箱子里/)
  assert.match(snapshot.prompt, /reasoning and debug/)
  assert.match(snapshot.prompt, /full tool log/)
})

test('oversized semipersistent projection preserves user evidence and marks omissions', (t) => {
  const { semi } = fixture(t)
  const large = segment()
  large.records[1].text = 'r'.repeat(20_000)
  semi.promote(large, { workspaceId: 'w', sessionId: 'source', workspaceTurn: 1 })
  const snapshot = semi.renderSnapshot('source', 'w', { budgetTokens: 100 })
  assert.match(snapshot.prompt, /档案柜钥匙在绿色箱子里/)
  assert.equal(snapshot.entries[0].omittedChars > 0, true)
})

test('bank separates workspace and user-global scope and tombstones immediately', (t) => {
  const { bank } = fixture(t)
  const local = bank.put({ content: '项目M的端口是8282', scopeKind: 'workspace', scopeId: 'w1', sourceRefs: [{ sessionId: 's', seq: 1 }], explicit: true })
  const global = bank.put({ content: '全局偏好是蓝色', scopeKind: 'user-global', scopeId: 'user-global', sourceRefs: [{ sessionId: 's', seq: 2 }], explicit: true })
  assert.equal(bank.listVisible({ workspaceId: 'w2' }).some((item) => item.id === local.record.id), false)
  assert.equal(bank.listVisible({ workspaceId: 'w2' }).some((item) => item.id === global.record.id), true)
  bank.forget(global.record.id, { workspaceId: 'w2', scope: 'user-global' })
  assert.equal(bank.listVisible({ workspaceId: 'w2' }).some((item) => item.id === global.record.id), false)
})

test('explicit multi-clause memory remains one bank parent with child vectors', (t) => {
  const { bank } = fixture(t)
  const stored = bank.put({ content: '蓝灯塔测试场景的档案柜钥匙位于绿色箱子里，验证短语是银杏-47', scopeKind: 'workspace', scopeId: 'w', sourceRefs: [{ sessionId: 's', seq: 4 }], explicit: true })
  assert.equal(stored.record.kind, 'context-parent')
  assert.equal(stored.record.childSpans.length, 1)
  assert.equal(stored.record.coreText, '蓝灯塔测试场景的档案柜钥匙位于绿色箱子里，验证短语是银杏-47')
  assert.deepEqual(stored.record.sourceRefs, [{ sessionId: 's', seq: 4 }])
  assert.equal(stored.record.vector.dimensions, 64)
})

test('async vector providers encode a bank chunk before it is persisted', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-async-vector-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(dir)
  const bank = new MemoryBank({
    ledger,
    chunker: new ContextChunker(),
    vectorEncoder: {
      async encodeBatch(texts) {
        return texts.map(() => ({ provider: 'http', model: 'small-local-test', dimensions: 3, values: [0.2, 0.4, 0.8] }))
      },
    },
  })
  const stored = await bank.putAsync({
    content: '项目M当前部署端口是8383。',
    scopeKind: 'workspace',
    scopeId: 'w',
    sourceRefs: [{ sessionId: 's', seq: 12 }],
    explicit: true,
  })
  assert.equal(stored.record.vector.provider, 'http')
  assert.equal(stored.record.vector.model, 'small-local-test')
  assert.equal(stored.record.vectorKey, `small-local-test:${stored.record.id}:children`)
})

test('standalone key-value memory has no entity or canonical-fact projection', (t) => {
  const { bank } = fixture(t)
  const stored = bank.put({ content: '通用发布代号是星桥-9', scopeKind: 'user-global', scopeId: 'user-global', sourceRefs: [{ sessionId: 's', seq: 8 }], explicit: true })
  assert.equal(stored.record.coreText, '通用发布代号是星桥-9')
  assert.equal('canonicalFacts' in stored.record, false)
  assert.equal('entities' in stored.record, false)
})

test('three strong uses across two sessions satisfy the default semipersistent-to-bank policy', (t) => {
  const { policy, semi } = fixture(t)
  semi.promote({ ...segment(), memoryType: 'verified-fact' }, { workspaceId: 'w', sessionId: 'source', workspaceTurn: 1 })
  let record = semi.associate('seg1', { sessionId: 'source', turn: 2, workspaceTurn: 2, weight: 1, verified: true }, 'w')
  record = semi.associate('seg1', { sessionId: 'target', turn: 1, workspaceTurn: 3, weight: 1, verified: true }, 'w')
  record = semi.associate('seg1', { sessionId: 'target', turn: 2, workspaceTurn: 4, weight: 1, verified: true }, 'w')
  assert.equal(policy.shouldPromoteToBank(record, { currentTurn: 4 }), true)
})
