import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LayeredMatchEngine } from '../lib/layered-match-engine.js'
import { MemoryBank } from '../lib/memory-bank.js'
import { MemoryLedger } from '../lib/memory-ledger.js'
import { MemoryRetrievalPlanner } from '../lib/memory-retrieval-planner.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'layered-match-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(dir)
  const bank = new MemoryBank({ ledger })
  return { ledger, bank, matcher: new LayeredMatchEngine({ ledger, bank }) }
}

function entry(id, title, sessionId, value = `${title} value`) {
  return { id, title, scopeKind: 'session', scopeId: sessionId, sessionId, aliases: [], canonicalFacts: [{ subject: title, predicate: 'states', value, current: true }], sourceRefs: [{ sessionId, seq: 1 }], evidenceQuality: 0.9, verifiedSource: true, approvedEpisode: true, episodeSummary: value }
}

test('fast matcher is session scoped and hard-rejects real pollution samples', (t) => {
  const { ledger, matcher } = fixture(t)
  ledger.upsert('sensoryEntries', entry('m1', '项目M', 's1', '项目M端口8282'), { scopeKind: 'session', scopeId: 's1', id: 'm1' })
  ledger.upsert('sensoryEntries', entry('m2', '项目M', 's2', '项目M端口9999'), { scopeKind: 'session', scopeId: 's2', id: 'm2' })
  for (const word of ['in', 'to', 'on', 'a', 'user', 'LLM']) ledger.upsert('sensoryEntries', entry(`noise-${word}`, word, 's1'), { scopeKind: 'session', scopeId: 's1', id: `noise-${word}` })
  const result = matcher.retrieve('项目M端口', { sessionId: 's1', workspaceId: 'w' })
  assert.equal(result.selected[0].id, 'm1')
  assert.equal(result.candidates.some((item) => item.id === 'm2'), false)
  assert.equal(matcher.retrieve('in to user LLM', { sessionId: 's1', workspaceId: 'w' }).qualified.length, 0)
})

test('bank is searched only after sensory lacks qualified evidence', (t) => {
  const { bank, matcher } = fixture(t)
  bank.put({ content: '项目B的部署端口是7070', scopeKind: 'workspace', scopeId: 'w', sourceRefs: [{ sessionId: 'source', seq: 9 }], sessionId: 'source', workspaceId: 'w', explicit: true })
  const result = matcher.retrieve('项目B的部署端口', { sessionId: 'target', workspaceId: 'w' })
  assert.equal(result.searchedBank, true)
  assert.equal(result.selected[0].layer, 'bank')
})

test('slow planner selects only offered candidates and deterministic verification rejects invented IDs', async (t) => {
  const { ledger, matcher } = fixture(t)
  ledger.upsert('sensoryEntries', entry('c1', '共享项目', 's', '端口1111'), { scopeKind: 'session', scopeId: 's', id: 'c1' })
  ledger.upsert('sensoryEntries', entry('c2', '共享项目', 's', '端口2222'), { scopeKind: 'session', scopeId: 's', id: 'c2' })
  const result = matcher.retrieve('共享项目端口', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.sufficient, false)
  const planner = new MemoryRetrievalPlanner({ matcher, llm: { async complete() { return JSON.stringify({ resolvedQuery: '共享项目当前端口', entityHints: ['共享项目'], timeConstraint: { kind: 'current', from: null, to: null }, selectedCandidateIds: ['invented', 'c1'], needOpen: true, confidence: 0.8 }) } } })
  const planned = await planner.plan(result, { sessionId: 's', turn: 1, step: 1, taskStateRevision: 1 })
  assert.deepEqual(planned.plan.selectedCandidateIds, ['c1'])
  assert.equal(planned.selected.every((item) => result.candidates.some((candidate) => candidate.id === item.id)), true)
})

test('coreference, temporal wording, and summary-only checkpoints force one slow-path decision', (t) => {
  const { ledger, matcher } = fixture(t)
  ledger.upsert('sensoryEntries', entry('fact', '项目T', 's', '项目T端口是9000'), { scopeKind: 'session', scopeId: 's', id: 'fact' })
  const coreference = matcher.retrieve('项目T现在的端口还是那个吗', { sessionId: 's', workspaceId: 'w' })
  assert.equal(coreference.sufficient, false)
  assert.equal(coreference.slowPathReasons.includes('coreference'), true)
  assert.equal(coreference.slowPathReasons.includes('temporal-constraint'), true)
  ledger.upsert('sensoryEntries', { ...entry('summary', '检查点Q', 's'), canonicalFacts: [], episodeSummary: '检查点Q只有摘要' }, { scopeKind: 'session', scopeId: 's', id: 'summary' })
  const summary = matcher.retrieve('检查点Q', { sessionId: 's', workspaceId: 'w' })
  assert.equal(summary.sufficient, false)
  assert.equal(summary.slowPathReasons.includes('checkpoint-summary-without-answer'), true)
})
