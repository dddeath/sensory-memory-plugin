import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DemotionEngine } from '../lib/demotion-engine.js'
import { ExtractionEngine } from '../lib/extraction-engine.js'
import { HaluMemAuditor } from '../lib/halu-mem-auditor.js'
import { InjectionEngine } from '../lib/injection-engine.js'
import { LLMExtractor } from '../lib/llm-extractor.js'
import { MatchEngine } from '../lib/match-engine.js'
import { SemipersistentCache } from '../lib/semipersistent-cache.js'
import { SensoryIndex } from '../lib/sensory-index.js'
import { SensoryMaintenance } from '../lib/sensory-maintenance.js'
import { createSensoryToolDefinitions } from '../lib/sensory-tools.js'
import { installStage3 } from '../lib/stage3.js'

function fixture(t, prefix = 'sensory-v5-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fakeContext() {
  const hooks = new Map()
  return {
    hooks,
    on(name, callback) { hooks.set(name, callback); return () => hooks.delete(name) },
    effect() {},
    tools: { register() { return () => {} } },
    systemPrompt: { context() { return () => {} } },
    logger: { info() {}, warn() {} },
  }
}

function agent(sessionId, history = []) {
  return { cwd: 'E:/benchmark', session: { id: sessionId, events: [], deriveMessages: () => history } }
}

test('pre-step injects a same-step user/plugin snapshot and llm/stream never mutates a frozen request', async () => {
  const hit = { id: 'e1', name: 'ServiceAlpha', summary: 'ServiceAlpha uses Port8181', source_refs: [{ seq: 7 }], scopeId: 'global' }
  const matcher = { match: async () => ({ engrams: [hit] }), matchSync: () => ({ engrams: [hit], topScore: 1 }), sensoryIndex: { get: () => null } }
  const injector = new InjectionEngine({ matcher })
  const ctx = fakeContext()
  installStage3(ctx, { enabled: true }, { injector, matcher, rewriter: null })
  const current = { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Which port?' }], source: { kind: 'user' } }
  const payload = { agent: agent('s1', [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'ServiceAlpha noted' }] }]), messages: [current], turn: 2, step: 1 }
  const decision = await ctx.hooks.get('agent/pre-step')(payload, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(decision.messages[0].role, 'user')
  assert.equal(decision.messages[0].source.kind, 'plugin')
  assert.equal(decision.messages[1], current)
  assert.match(decision.messages[0].content[0].text, /\[\[ServiceAlpha\]\]/)

  const frozenMessages = Object.freeze([{ role: 'user', content: 'x' }])
  const frozen = Object.freeze({ sessionId: 's1', messages: frozenMessages })
  const stream = { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
  assert.equal(ctx.hooks.get('llm/stream')(frozen, () => stream), stream)
  assert.deepEqual(frozen.messages, frozenMessages)
})

test('pre-step keeps zero snapshot on no hit, deduplicates a consecutive catalog, and awaits fallback for the same step', async () => {
  const hit = { id: 'e1', name: 'ProjectFallback', summary: 'port 8282', source_refs: [{ seq: 8 }] }
  const matcher = { match: async () => ({ engrams: [] }), matchSync: () => ({ engrams: [], topScore: 0 }), sensoryIndex: { get: () => null } }
  const injector = new InjectionEngine({ matcher })
  let fallbackCalls = 0
  const rewriter = { enabled: true, stats: {}, async maybeRewrite() { fallbackCalls += 1; return { hits: [hit], entrySeqs: [8], rewrittenQuery: 'ProjectFallback', fromCache: false } } }
  const ctx = fakeContext()
  installStage3(ctx, {}, { injector, matcher, rewriter })
  const current = { id: 'u', role: 'user', content: [{ type: 'text', text: 'port?' }], source: { kind: 'user' } }
  const first = await ctx.hooks.get('agent/pre-step')({ agent: agent('s', []), messages: [current], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.equal(fallbackCalls, 1)
  assert.equal(first.messages[0].source.kind, 'plugin')
  const history = [first.messages[0]]
  const second = await ctx.hooks.get('agent/pre-step')({ agent: agent('s', history), messages: [current], turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(second.messages, [current])

  rewriter.enabled = false
  const third = await ctx.hooks.get('agent/pre-step')({ agent: agent('s2', []), messages: [current], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [current] }))
  assert.deepEqual(third.messages, [current])
})

test('same-name entities, matcher, cache, tools, and audit remain isolated by session scope', async (t) => {
  const index = new SensoryIndex(fixture(t), { legacyMirror: false })
  const one = index.addEntity({ name: 'SharedName', observations: ['SharedName uses Alpha'], sourceRef: { sessionId: 's1', seq: 1 }, scopeId: 's1' })
  const two = index.addEntity({ name: 'SharedName', observations: ['SharedName uses Beta'], sourceRef: { sessionId: 's2', seq: 2 }, scopeId: 's2' })
  assert.notEqual(one, two)
  assert.equal(index.getEntityByName('SharedName', 's1').observations[0], 'SharedName uses Alpha')
  assert.equal(index.getEntityByName('SharedName', 's2').observations[0], 'SharedName uses Beta')

  const matcher = new MatchEngine(index, { indexScope: 'session' })
  assert.equal(matcher.matchSync('SharedName', { sessionId: 's1' }).engrams[0].id, one)
  assert.equal(matcher.matchSync('SharedName', { sessionId: 's2' }).engrams[0].id, two)

  const cache = new SemipersistentCache({ index, config: { promoteAfter: 1 } })
  cache.onHit(one, { scopeId: 's1' })
  assert.equal(cache.status('s1').entryCount, 1)
  assert.equal(cache.status('s2').entryCount, 0)

  const extractor = new ExtractionEngine()
  const demoter = new DemotionEngine({ index, extractor, matcher, config: { indexScope: 'session' } })
  const tools = new Map(createSensoryToolDefinitions({ index, matcher, extractor, demoter, cache }).map((tool) => [tool.name, tool]))
  const exec = (id) => ({ agent: { session: { id, events: [] } } })
  const recall = JSON.parse(await tools.get('sensory_recall').execute({ query: 'SharedName' }, exec('s2')))
  assert.equal(recall.candidates[0].observations[0], 'SharedName uses Beta')
  const status = JSON.parse(await tools.get('sensory_status').execute({}, exec('s1')))
  assert.equal(status.entityCount, 1)

  const audit = await new HaluMemAuditor({ index, llm: null }).audit(10, 's1')
  assert.equal(audit.sampleSize, 1)
  assert.equal(audit.scopeId, 's1')
})

test('demotion performs one matcher query per turn and explicit relations are created only when a relation phrase exists', async (t) => {
  const index = new SensoryIndex(fixture(t), { legacyMirror: false })
  const extractor = new ExtractionEngine()
  let calls = 0
  const matcher = { async match() { calls += 1; return { engrams: [] } }, markDirty() {}, warm() {} }
  const demoter = new DemotionEngine({ index, extractor, matcher })
  demoter.state.tracked.push(
    { key: 'a', sessionId: 's', sourceSeq: 1, kind: 'message', entityNames: ['A'], keywords: [], unrefCount: 0, demoted: false },
    { key: 'b', sessionId: 's', sourceSeq: 2, kind: 'message', entityNames: ['B'], keywords: [], unrefCount: 0, demoted: false },
  )
  await demoter.onTurnEnd({ turn: 2, sessionId: 's', queryText: 'unrelated query', messages: [] })
  assert.equal(calls, 1)

  const explicit = extractor.extractFromText('ServiceA depends on DatabaseB')
  assert.deepEqual(explicit.relations.map((item) => item.relationType), ['depends_on'])
  assert.equal(extractor.extractFromText('ServiceA DatabaseB').relations.length, 0)
})

test('generic English entities enter cache when observations and confidence satisfy the public rule', (t) => {
  const index = new SensoryIndex(fixture(t), { legacyMirror: false })
  const id = index.addEntity({ name: 'ServiceAlpha', entityType: 'generic', observations: ['ServiceAlpha uses PostgreSQL'], confidence: 0.8 })
  const cache = new SemipersistentCache({ index, config: { promoteAfter: 3 } })
  cache.onHit(id); cache.onHit(id)
  assert.equal(cache.onHit(id).cached, true)
  assert.equal(cache.status().entries[0].entity, 'ServiceAlpha')
  assert.equal(index.stats().entityCount, 1)
})

test('journal replays, truncates only a broken tail, compacts atomically, and refine drain converges', async (t) => {
  const dir = fixture(t, 'sensory-journal-')
  const index = new SensoryIndex(dir, { legacyMirror: false, journalCompactAfter: 100 })
  const id = index.addEntity({ name: 'JournalEntity', observations: ['value=1'] })
  index.flush()
  assert.match(readFileSync(join(dir, 'mutations.jsonl'), 'utf8'), /"collection":"entities"/)
  assert.equal(new SensoryIndex(dir, { legacyMirror: false }).get(id).name, 'JournalEntity')
  appendFileSync(join(dir, 'mutations.jsonl'), '{broken-tail', 'utf8')
  const recovered = new SensoryIndex(dir, { legacyMirror: false })
  assert.equal(recovered.stats().recovery.type, 'truncated-tail')

  const compactDir = fixture(t, 'sensory-compact-')
  const compact = new SensoryIndex(compactDir, { legacyMirror: false, journalCompactAfter: 10 })
  for (let i = 0; i < 6; i += 1) compact.addEntity({ name: `Entity${i}`, observations: [`value=${i}`] })
  compact.flush()
  assert.equal(readFileSync(join(compactDir, 'mutations.jsonl'), 'utf8'), '')
  assert.equal(new SensoryIndex(compactDir, { legacyMirror: false }).count(), 6)
  assert.equal(readdirSync(compactDir).some((name) => name.includes('.tmp-')), false)

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const extractor = new LLMExtractor({ llm: { async complete() { await gate; return { entities: [{ name: 'JournalEntity' }] } } }, index })
  const pending = extractor.settle([{ entityIds: [id], text: 'JournalEntity', scopeId: 'global' }])
  assert.equal(extractor.status().active, true)
  release()
  await Promise.all([pending, extractor.drain('global')])
  assert.equal(extractor.status().pending, 0)
})

test('interior journal damage is reported and legacy cleanup is backed up exactly once', (t) => {
  const corruptDir = fixture(t, 'sensory-corrupt-')
  const corrupt = new SensoryIndex(corruptDir, { legacyMirror: false, journalCompactAfter: 100 })
  corrupt.addEntity({ name: 'Interior', observations: ['value=1'] })
  corrupt.flush()
  const lines = readFileSync(join(corruptDir, 'mutations.jsonl'), 'utf8').trim().split(/\r?\n/)
  writeFileSync(join(corruptDir, 'mutations.jsonl'), `${lines[0]}\n{broken-middle\n${lines[1]}\n`, 'utf8')
  assert.throws(() => new SensoryIndex(corruptDir, { legacyMirror: false }), /Invalid mutation journal/)

  const migrationDir = fixture(t, 'sensory-migration-')
  const index = new SensoryIndex(migrationDir)
  index.addEntity({ name: 'RESULT' })
  index.addEntity({ name: 'ProjectKeep', observations: ['ProjectKeep=value'] })
  index.flush()
  const extractor = new LLMExtractor({ llm: null, index })
  const first = extractor.migrateLegacyOnce()
  const second = extractor.migrateLegacyOnce()
  assert.equal(first.skipped, false)
  assert.equal(second.skipped, true)
  assert.equal(index.getEntityByName('RESULT'), null)
  assert.equal(existsSync(first.marker), true)
  assert.equal(existsSync(join(first.backupDir, 'entities.jsonl')), true)
})

test('maintenance finalizes short history, drains refinement, and drops only the completed session scope', async (t) => {
  const index = new SensoryIndex(fixture(t), { legacyMirror: false })
  const extractor = new ExtractionEngine()
  const matcher = new MatchEngine(index, { indexScope: 'session' })
  const demoter = new DemotionEngine({ index, extractor, matcher, config: { indexScope: 'session', msgRounds: 5 } })
  await demoter.onTurnEnd({ turn: 1, sessionId: 's1', messages: [{ role: 'assistant', sourceSeq: 1, text: 'ServiceOne=alpha' }] })
  await demoter.onTurnEnd({ turn: 1, sessionId: 's2', messages: [{ role: 'assistant', sourceSeq: 2, text: 'ServiceTwo=beta' }] })
  const llmExtractor = new LLMExtractor({ llm: null, index })
  const cache = new SemipersistentCache({ index })
  const rewriter = { dropScope: (scopeId) => ({ scopeId, removed: 0 }) }
  const maintenance = new SensoryMaintenance({ index, demoter, matcher, llmExtractor, cache, rewriter, config: { indexScope: 'session' } })
  const finalized = await maintenance.finalizeSession('s1')
  assert.equal(finalized.demotion.demoted, 1)
  assert.ok(index.getEntityByName('ServiceOne', 's1'))
  await maintenance.finalizeSession('s2')
  const dropped = await maintenance.dropScope('s1')
  assert.equal(dropped.before.index.entityCount > 0, true)
  assert.equal(index.count('s1'), 0)
  assert.equal(index.count('s2') > 0, true)
})
