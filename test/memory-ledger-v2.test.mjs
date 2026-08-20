import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MemoryLedger } from '../lib/memory-ledger.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'layer-ledger-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Layer Ledger persists scoped records and replays the append-only journal', (t) => {
  const dir = fixture(t)
  const ledger = new MemoryLedger(dir, { journalCompactAfter: 100 })
  ledger.upsert('sensoryEntries', { id: 'same', title: 'A' }, { scopeKind: 'session', scopeId: 's1', id: 'same' })
  ledger.upsert('sensoryEntries', { id: 'same', title: 'B' }, { scopeKind: 'session', scopeId: 's2', id: 'same' })
  assert.equal(ledger.list('sensoryEntries', { scopeKind: 'session', scopeId: 's1' })[0].title, 'A')
  assert.equal(new MemoryLedger(dir).list('sensoryEntries', { scopeKind: 'session', scopeId: 's2' })[0].title, 'B')
  assert.match(readFileSync(join(dir, 'ledger.journal.jsonl'), 'utf8'), /"sequence":1/)
})

test('Layer Ledger recovers only a broken final line and compacts atomically', (t) => {
  const dir = fixture(t)
  const ledger = new MemoryLedger(dir, { journalCompactAfter: 100 })
  ledger.upsert('sourceSegments', { id: 'seg', value: 1 }, { scopeKind: 'session', scopeId: 's', id: 'seg' })
  appendFileSync(join(dir, 'ledger.journal.jsonl'), '{broken-tail', 'utf8')
  const recovered = new MemoryLedger(dir, { journalCompactAfter: 100 })
  assert.equal(recovered.status().recovery.type, 'truncated-tail')
  recovered.compact()
  assert.equal(readFileSync(join(dir, 'ledger.journal.jsonl'), 'utf8'), '')
  assert.equal(new MemoryLedger(dir).get('sourceSegments', 'seg', { scopeKind: 'session', scopeId: 's' }).value, 1)
})

test('scope mutation queue serializes writes and drain reports convergence', async (t) => {
  const ledger = new MemoryLedger(fixture(t))
  const order = []
  const first = ledger.enqueue('session:s', async () => { await new Promise((resolve) => setTimeout(resolve, 15)); order.push(1) })
  const second = ledger.enqueue('session:s', async () => { order.push(2) })
  assert.deepEqual((await ledger.drain('session:s', 1000)).failures, [])
  await Promise.all([first, second])
  assert.deepEqual(order, [1, 2])
})
