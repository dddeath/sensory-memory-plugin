import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LayeredMatchEngine } from '../lib/layered-match-engine.js'
import { MemoryBank } from '../lib/memory-bank.js'
import { MemoryLedger } from '../lib/memory-ledger.js'
import { MemoryRetrievalPlanner } from '../lib/memory-retrieval-planner.js'
import { buildRetrievalFeatures } from '../lib/memory-retrieval-features.js'

const BLUE_TEXT = '【蓝灯塔情景定义】代号"蓝灯塔"测试情景：档案柜钥匙放在北侧窗台下的绿色盒子里；校验短语是"银杏-47"。强制下降至感知层（原始定义，非转述）。'

function fixture(t, { source = { role: 'user', text: BLUE_TEXT }, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'index-match-fix-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledger = new MemoryLedger(dir)
  const bank = new MemoryBank({ ledger })
  const matcher = new LayeredMatchEngine({ ledger, bank, sourceReader: () => source, config })
  return { ledger, bank, matcher }
}

function blueEntry(sessionId = 's', id = 'blue') {
  const sourceRefs = [{ sessionId, seq: 22 }]
  const features = buildRetrievalFeatures(BLUE_TEXT, { sourceRefs })
  return {
    id,
    title: features.title,
    aliases: features.aliases,
    retrievalFeatureVersion: features.retrievalFeatureVersion,
    retrievalTerms: features.retrievalTerms,
    evidenceSourceRefs: features.evidenceSourceRefs,
    scopeKind: 'session',
    scopeId: sessionId,
    sessionId,
    canonicalFacts: [],
    episodeSummary: BLUE_TEXT,
    approvedEpisode: true,
    sourceRefs,
    evidenceQuality: 0.9,
    verifiedSource: true,
  }
}

function store(ledger, entry) {
  ledger.upsert('sensoryEntries', entry, { scopeKind: 'session', scopeId: entry.sessionId, id: entry.id })
}

test('trusted retrieval features give the real blue-lighthouse checkpoint a readable title and bounded terms', () => {
  const result = buildRetrievalFeatures(BLUE_TEXT, { sourceRefs: [{ sessionId: 's', seq: 22 }] })
  assert.equal(result.title, '蓝灯塔情景定义')
  assert.equal(result.aliases.includes('蓝灯塔'), true)
  assert.equal(result.retrievalTerms.length <= 32, true)
  assert.equal(result.retrievalTerms.some((term) => term.value === '档案柜钥匙' && term.kind === 'subject'), true)
  assert.equal(result.retrievalTerms.some((term) => term.value === '银杏-47'), true)
  assert.equal(result.retrievalTerms.some((term) => term.value.includes('】代号')), false)
  assert.deepEqual(result.evidenceSourceRefs, [{ sessionId: 's', seq: 22 }])
})

test('a trusted label outranks a generic extracted name and generic OK is not indexable', () => {
  const result = buildRetrievalFeatures(`${BLUE_TEXT} 只回复 OK。`, {
    entities: [{ name: 'OK', aliases: [], keywords: ['ok'] }],
    sourceRefs: [{ sessionId: 's', seq: 22 }],
  })
  assert.equal(result.title, '蓝灯塔情景定义')
  assert.equal(result.retrievalTerms.some((term) => term.value.toLowerCase() === 'ok'), false)
})

test('blue-lighthouse multi-anchor query is source-verified and directly selected above the unchanged threshold', (t) => {
  const { ledger, matcher } = fixture(t)
  store(ledger, blueEntry())
  const result = matcher.retrieve('蓝灯塔 钥匙 银杏', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.topScore, 1)
  assert.equal(result.selected[0].id, 'blue')
  assert.equal(result.selected[0].summaryOnly, true)
  assert.equal(result.selected[0].sourceValidation.reason, 'source-term-verified')
  assert.equal(result.bestRawCandidate.sourceEvidenceScore, 1)
  assert.equal(result.qualifiedCandidateCount, 1)
})

test('one partial anchor remains a 0.35 slow-path candidate and resolvedQuery deterministically rescues it', async (t) => {
  const { ledger, matcher } = fixture(t)
  store(ledger, blueEntry())
  const result = matcher.retrieve('上次那个钥匙在哪里', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.topScore, 0)
  assert.equal(result.bestRawScore, 0.35)
  assert.equal(result.selected.length, 0)
  assert.equal(result.slowPathReasons.includes('coreference'), true)
  const planner = new MemoryRetrievalPlanner({
    matcher,
    llm: { async complete() { return JSON.stringify({ resolvedQuery: '蓝灯塔 档案柜钥匙', entityHints: ['蓝灯塔'], timeConstraint: { kind: 'current', from: null, to: null }, selectedCandidateIds: ['blue'], needOpen: true, confidence: 0.8 }) } },
  })
  const planned = await planner.plan(result, { sessionId: 's', turn: 1, step: 1, taskStateRevision: 1 })
  assert.equal(planned.verified, true)
  assert.equal(planned.selected[0].id, 'blue')
  assert.equal(planned.selected[0].effectiveRelevance, 1)
  assert.equal(planned.selected[0].sourceDirect, true)
  assert.equal(planner.status().verifiedHits, 1)
  assert.equal(matcher.status().resolvedQueryRechecks, 1)
})

test('missing, untrusted, and mismatched sources keep summary-only candidates out of automatic evidence', async (t) => {
  const cases = [
    { source: null, reason: 'source-unavailable' },
    { source: { role: 'tool', toolName: 'search', text: BLUE_TEXT }, reason: 'source-role-not-trusted' },
    { source: { role: 'user', text: '另一个完全无关的情景' }, reason: 'source-term-mismatch' },
  ]
  for (const [index, item] of cases.entries()) {
    await t.test(item.reason, (subtest) => {
      const { ledger, matcher } = fixture(subtest, { source: item.source })
      store(ledger, blueEntry(`s${index}`))
      const result = matcher.retrieve('蓝灯塔 钥匙 银杏', { sessionId: `s${index}`, workspaceId: 'w' })
      assert.equal(result.selected.length, 0)
      assert.equal(result.bestRawCandidate.sourceValidation.reason, item.reason)
      assert.equal(result.slowPathReasons.includes(item.reason), true)
    })
  }
})

test('a source cannot borrow a weak partial token to validate a different full retrieval term', (t) => {
  const { ledger, matcher } = fixture(t, { source: { role: 'user', text: '档案柜钥匙在另一个位置。' } })
  store(ledger, blueEntry())
  const result = matcher.retrieve('蓝灯塔 钥匙', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.bestRawCandidate.sourceValidation.ok, true)
  assert.equal(result.bestRawCandidate.sourceValidation.verifiedScore, 0.35)
  assert.equal(result.bestRawCandidate.sourceEvidenceScore, 0.35)
  assert.equal(result.selected.length, 0)
})

test('explicitly trusted tool evidence may validate a summary-only checkpoint', (t) => {
  const { ledger, matcher } = fixture(t, { source: { role: 'tool', toolName: 'trusted-db', text: BLUE_TEXT }, config: { trustedEvidenceTools: ['trusted-db'] } })
  store(ledger, blueEntry())
  const result = matcher.retrieve('蓝灯塔 银杏-47', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.selected[0].id, 'blue')
  assert.equal(result.selected[0].sourceValidation.ok, true)
})

test('pollution, code, URL, and path fragments do not become trusted retrieval terms', () => {
  const result = buildRetrievalFeatures('in to on a user LLM https://example.test C:\\temp\\x npm node scm=value', { sourceRefs: [{ sessionId: 's', seq: 1 }] })
  const values = result.retrievalTerms.map((term) => term.value.toLowerCase())
  for (const word of ['in', 'to', 'on', 'a', 'user', 'llm']) assert.equal(values.includes(word), false)
  assert.equal(values.some((value) => value.includes('http') || value.includes('scm=') || value.includes('\\')), false)
})

test('same retrieval terms remain session isolated and duplicate candidates fail the margin gate', (t) => {
  const { ledger, matcher } = fixture(t)
  store(ledger, blueEntry('s1', 'one'))
  store(ledger, blueEntry('s2', 'other-session'))
  let result = matcher.retrieve('蓝灯塔 钥匙 银杏', { sessionId: 's1', workspaceId: 'w' })
  assert.deepEqual(result.candidates.map((item) => item.id), ['one'])
  store(ledger, blueEntry('s1', 'two'))
  result = matcher.retrieve('蓝灯塔 钥匙 银杏', { sessionId: 's1', workspaceId: 'w' })
  assert.equal(result.sufficient, false)
  assert.equal(result.margin, 0)
  assert.equal(result.slowPathReasons.includes('low-margin'), true)
})

test('legacy summary-only records and hash-only collisions never gain source evidence', (t) => {
  const { ledger, matcher } = fixture(t)
  store(ledger, {
    id: 'legacy', title: 'session-s-turn-22', aliases: [], canonicalFacts: [], episodeSummary: BLUE_TEXT, approvedEpisode: true,
    sourceRefs: [{ sessionId: 's', seq: 22 }], scopeKind: 'session', scopeId: 's', sessionId: 's', evidenceQuality: 0.9, verifiedSource: true,
  })
  matcher.hasher = { hash() { return 1 }, slotKeys() { return ['forced-collision'] } }
  const result = matcher.retrieve('completely unrelated query', { sessionId: 's', workspaceId: 'w' })
  assert.equal(result.generatedCandidateCount, 1)
  assert.equal(result.bestRawScore, 0)
  assert.equal(result.qualifiedCandidateCount, 0)
  assert.equal(result.selected.length, 0)
})
