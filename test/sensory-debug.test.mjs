import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DemotionEngine, IndexSourceStore } from '../lib/demotion-engine.js'
import { ExtractionEngine } from '../lib/extraction-engine.js'
import { FallbackRewriter } from '../lib/fallback-rewriter.js'
import { InjectionEngine } from '../lib/injection-engine.js'
import { MatchEngine } from '../lib/match-engine.js'
import { SemipersistentCache } from '../lib/semipersistent-cache.js'
import { SensoryDebugService } from '../lib/sensory-debug.js'
import { SensoryIndex } from '../lib/sensory-index.js'
import { createSensoryToolDefinitions } from '../lib/sensory-tools.js'
import { installStage3 } from '../lib/stage3.js'

const GUIDE = '（感知记忆索引：调试样例）'

function fixture(t, { indexScope = 'session' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sensory-debug-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = { indexScope, promoteAfter: 1 }
  const index = new SensoryIndex(join(dir, 'index'), { ...config, legacyMirror: false })
  const extractor = new ExtractionEngine()
  const matcher = new MatchEngine(index, config)
  const sourceStore = new IndexSourceStore(index)
  const demoter = new DemotionEngine({ index, extractor, matcher, sourceStore, config })
  const injector = new InjectionEngine({ matcher, config })
  const cache = new SemipersistentCache({ index, config })
  const rewriter = new FallbackRewriter({ matcher, llm: null, config })
  const maintenance = { async drain(sessionId) { return { ok: true, sessionId } } }
  const debug = new SensoryDebugService({
    index, matcher, extractor, sourceStore, demoter, injector, cache, rewriter, maintenance, config,
  })
  const exec = (sessionId = 's1') => ({
    cwd: dir,
    agent: {
      cwd: dir,
      session: {
        id: sessionId,
        events: [{ seq: 9 }],
        header: { cwd: dir, title: 'debug fixture' },
        deriveMessages: () => [{ id: 'derived-user', role: 'user', content: 'derived input' }],
      },
    },
  })
  return { dir, config, index, extractor, matcher, sourceStore, demoter, injector, cache, rewriter, maintenance, debug, exec }
}

function catalogMessage(text) {
  return {
    id: 'catalog',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@local/sensory-memory', purpose: 'sensory-catalog' },
  }
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

test('last prompt captures exact system, tools, messages, attributes, and separates main from auxiliary', (t) => {
  const { debug, exec } = fixture(t)
  const main = Object.freeze({
    sessionId: 's1',
    provider: 'fixture-provider',
    model: 'fixture-model',
    system: 'SYSTEM-CONTEXT',
    tools: [{ name: 'fixture_tool', description: 'fixture' }],
    messages: Object.freeze([{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] }]),
  })
  debug.captureRequest(main)
  const auxiliary = { sessionId: 's1', purpose: 'sensory-rewrite', system: 'REWRITE', tools: [], messages: [] }
  debug.captureRequest(auxiliary, { auxiliary: true })

  const payload = debug.fullPrompt(exec('s1'), 'main')
  assert.equal(payload.available, true)
  assert.equal(payload.capture.request.system, 'SYSTEM-CONTEXT')
  assert.equal(payload.capture.request.tools[0].name, 'fixture_tool')
  assert.equal(payload.capture.request.messages[0].content[0].text, 'hello')
  assert.equal(payload.capture.request.options.provider, 'fixture-provider')
  assert.equal(payload.capture.attributes.frozen, true)
  assert.equal(debug.fullPrompt(exec('s1'), 'auxiliary').capture.purpose, 'sensory-rewrite')
})

test('cache and sensory index views split the exact last catalog and expose layer attributes', (t) => {
  const { index, cache, matcher, injector, debug, exec } = fixture(t)
  const cacheId = index.addEntity({
    name: 'CacheEntity', observations: ['CacheEntity uses 8181'], confidence: 0.9,
    sourceRef: { sessionId: 's1', seq: 1 }, scopeId: 's1',
  })
  index.addEntity({
    name: 'IndexEntity', observations: ['IndexEntity uses 8282'], confidence: 0.9,
    sourceRef: { sessionId: 's1', seq: 2 }, scopeId: 's1',
  })
  index.flush()
  matcher.markDirty()
  cache.onHit(cacheId, { scopeId: 's1', turnKey: 't1' })
  injector.lastInjection = { inserted: true, insertIndex: 2 }
  const catalog = `${GUIDE}\n<memory>\n- [cache] [[CacheEntity]] [seq 1] CacheEntity uses 8181\n- [[IndexEntity]] [seq 2] IndexEntity uses 8282\n</memory>`
  debug.captureRequest({ sessionId: 's1', system: 'system', tools: [], messages: [catalogMessage(catalog)] })

  const cacheView = debug.cachePrompt(exec('s1'))
  const indexView = debug.indexPrompt(exec('s1'))
  assert.match(cacheView.prompt, /\[cache\] \[\[CacheEntity\]\]/)
  assert.doesNotMatch(cacheView.prompt, /IndexEntity/)
  assert.equal(cacheView.entries[0].hitCount, 1)
  assert.equal(cacheView.entries[0].inLastPrompt, true)
  assert.match(indexView.prompt, /\[\[IndexEntity\]\]/)
  assert.doesNotMatch(indexView.prompt, /\[cache\]/)
  assert.equal(indexView.entries[0].record.observations[0], 'IndexEntity uses 8282')
  assert.equal(indexView.attributes.index.entityCount, 2)
  assert.equal(indexView.attributes.catalogMessage.source.purpose, 'sensory-catalog')
})

test('working layer view excludes the plugin catalog and reports message, source, block, and tool-pair attributes', (t) => {
  const { debug, demoter, exec } = fixture(t)
  demoter.state.tracked.push({
    key: 'tracked-1', sessionId: 's1', scopeId: 's1', sourceSeq: 4, turn: 1,
    role: 'assistant', kind: 'message', text: 'working fact', keywords: ['working'], entityNames: [], unrefCount: 1,
  })
  const catalog = `${GUIDE}\n<memory>\n- [[IndexEntity]] [seq 2] value\n</memory>`
  debug.captureRequest({
    sessionId: 's1',
    system: 'system',
    tools: [],
    messages: [
      catalogMessage(catalog),
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } },
      { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'fixture_tool' }] },
      { id: 't1', role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', output: 'done' }], source: { kind: 'tool' } },
    ],
  })

  const view = debug.workingPrompt(exec('s1'))
  assert.equal(view.attributes.providerMessageCount, 4)
  assert.equal(view.attributes.workingMessageCount, 3)
  assert.equal(view.attributes.catalogMessagesExcluded, 1)
  assert.deepEqual(view.attributes.toolCalls, ['call-1'])
  assert.deepEqual(view.attributes.toolResults, ['call-1'])
  assert.deepEqual(view.attributes.unmatchedToolCalls, [])
  assert.equal(view.attributes.tracked[0].key, 'tracked-1')
  assert.equal(view.sessionDerivedMessages[0].id, 'derived-user')
})

test('debug output routes to conversation, markdown, JSON, or both inside the current workspace', (t) => {
  const { debug, exec, dir } = fixture(t)
  const payload = debug.fullPrompt(exec('s1'))
  assert.equal(JSON.parse(debug.output(payload, { output: 'conversation' }, exec('s1'))).available, false)

  const documentOnly = JSON.parse(debug.output(payload, {
    output: 'document', documentPath: 'debug/last-prompt.json', title: 'Last Prompt',
  }, exec('s1')))
  assert.equal(documentOnly.document.format, 'json')
  assert.equal(JSON.parse(readFileSync(join(dir, 'debug', 'last-prompt.json'), 'utf8')).kind, payload.kind)

  const both = JSON.parse(debug.output(payload, {
    output: 'both', documentPath: 'debug/last-prompt.md', title: 'Last Prompt',
  }, exec('s1')))
  assert.equal(both.document.format, 'markdown')
  assert.match(readFileSync(join(dir, 'debug', 'last-prompt.md'), 'utf8'), /^# Last Prompt/m)
  assert.throws(() => debug.output(payload, { output: 'document', documentPath: '../outside.md' }, exec('s1')), /inside current workspace/)
})

test('confirmed session-scope clear removes index, source, cache, rewrite, and tracked state only for the current session', async (t) => {
  const { index, cache, demoter, debug, exec } = fixture(t)
  const add = (scopeId, seq) => {
    const sourceRef = { sessionId: scopeId, seq }
    const id = index.addEntity({ name: `Entity-${scopeId}`, observations: [`value-${scopeId}`], confidence: 0.9, sourceRef, scopeId })
    index.writeSource(sourceRef, { text: `source-${scopeId}` })
    cache.onHit(id, { scopeId, turnKey: `turn-${scopeId}` })
    demoter.state.tracked.push({ key: scopeId, sessionId: scopeId, scopeId, sourceSeq: seq, text: `tracked-${scopeId}` })
  }
  add('s1', 1)
  add('s2', 2)
  index.writeSource({ sessionId: 's1', seq: 99 }, { text: 'orphan-source-s1' })
  index.flush()
  index.writeRounds(demoter.state)

  const preview = await debug.clearWorkspaceIndex(exec('s1'), { confirm: false })
  assert.equal(preview.cleared, false)
  assert.equal(index.count('s1'), 1)

  const cleared = await debug.clearWorkspaceIndex(exec('s1'), { confirm: true })
  assert.equal(cleared.cleared, true)
  assert.equal(cleared.effectiveTarget, 'current-session-index-scope')
  assert.equal(index.count('s1'), 0)
  assert.equal(index.count('s2'), 1)
  assert.equal(cache.status('s1').entryCount, 0)
  assert.equal(cache.status('s2').entryCount, 1)
  assert.equal(demoter.state.tracked.some((item) => item.scopeId === 's1'), false)
  assert.equal(demoter.state.tracked.some((item) => item.scopeId === 's2'), true)
  assert.equal(index.readSource({ sessionId: 's1', seq: 1 }), null)
  assert.equal(index.readSource({ sessionId: 's1', seq: 99 }), null)
  assert.equal(index.readSource({ sessionId: 's2', seq: 2 }).text, 'source-s2')
  assert.equal(debug.consumeTurnStoppingSkip('s1', 1), true)
  assert.equal(debug.consumeTurnStoppingSkip('s1', 1), false)
  const reloaded = new SensoryIndex(index.indexDir, { legacyMirror: false })
  assert.equal(reloaded.count('s1'), 0)
  assert.equal(reloaded.count('s2'), 1)
})

test('confirmed global clear removes the current DSH profile global index and all five debug tools are registered', async (t) => {
  const { index, cache, demoter, debug, exec, extractor, matcher, sourceStore, injector } = fixture(t, { indexScope: 'global' })
  const sourceRef = { sessionId: 'global-session', seq: 7 }
  const id = index.addEntity({ name: 'GlobalEntity', observations: ['global value'], confidence: 0.9, sourceRef })
  index.writeSource(sourceRef, { text: 'global source' })
  index.writeSource({ sessionId: 'global-orphan', seq: 99 }, { text: 'global orphan source' })
  index.flush()
  cache.onHit(id, { scopeId: 'global', turnKey: 'global-turn' })
  demoter.state.tracked.push({ key: 'global', sessionId: 'global-session', scopeId: 'global', sourceSeq: 7, text: 'tracked' })
  index.writeRounds(demoter.state)

  const tools = new Map(createSensoryToolDefinitions({
    index, matcher, extractor, sourceStore, demoter, injector, cache,
    auditor: { async audit() { return {} }, async maybeCircuitBreak() { return {} } },
    debug,
  }).map((tool) => [tool.name, tool]))
  for (const name of [
    'sensory_debug_last_prompt', 'sensory_debug_cache_prompt', 'sensory_debug_index_prompt',
    'sensory_debug_working_prompt', 'sensory_clear_workspace_index',
  ]) assert.equal(tools.has(name), true, name)
  assert.equal(tools.size, 12)

  const preview = JSON.parse(await tools.get('sensory_clear_workspace_index').execute({ confirm: false }, exec('global-session')))
  assert.equal(preview.cleared, false)
  const result = JSON.parse(await tools.get('sensory_clear_workspace_index').execute({ confirm: true }, exec('global-session')))
  assert.equal(result.cleared, true)
  assert.equal(result.effectiveTarget, 'current-dsh-profile-global-index')
  assert.equal(index.count('global'), 0)
  assert.equal(cache.status('global').entryCount, 0)
  assert.equal(demoter.state.tracked.length, 0)
  assert.equal(existsSync(join(index.indexDir, 'source', 'global-session', '7.json')), false)
  assert.equal(existsSync(join(index.indexDir, 'source', 'global-orphan', '99.json')), false)
  assert.equal(new SensoryIndex(index.indexDir, { legacyMirror: false }).count('global'), 0)
})

test('llm/stream remains read-only while capturing main and auxiliary prompt snapshots for the DSH tool', (t) => {
  const { debug, injector, matcher, exec } = fixture(t)
  const auxiliaryRequests = new WeakSet()
  const ctx = fakeContext()
  installStage3(ctx, {}, { injector, matcher, rewriter: null, debug, auxiliaryRequests })
  const stream = { async *[Symbol.asyncIterator]() { yield { type: 'finish', reason: { kind: 'stop' } } } }
  const main = Object.freeze({ sessionId: 's1', system: 'system-main', tools: [], messages: Object.freeze([]) })
  assert.equal(ctx.hooks.get('llm/stream')(main, () => stream), stream)
  assert.equal(debug.fullPrompt(exec('s1'), 'main').capture.request.system, 'system-main')

  const auxiliary = Object.freeze({ sessionId: 's1', purpose: 'sensory-audit', system: 'system-aux', tools: [], messages: Object.freeze([]) })
  auxiliaryRequests.add(auxiliary)
  assert.equal(ctx.hooks.get('llm/stream')(auxiliary, () => stream), stream)
  assert.equal(debug.fullPrompt(exec('s1'), 'main').capture.request.system, 'system-main')
  assert.equal(debug.fullPrompt(exec('s1'), 'auxiliary').capture.request.system, 'system-aux')
  assert.equal(Object.isFrozen(main.messages), true)
})
