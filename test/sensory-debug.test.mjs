import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { installChunkMemory } from '../lib/install-chunk-memory.js'
import { SensoryDebugService } from '../lib/sensory-debug.js'
import { createSensoryToolDefinitions } from '../lib/sensory-tools.js'
import { runtimeFixture, testSession } from './helpers/runtime-fixture.mjs'

function fixture(t) {
  const services = runtimeFixture(t)
  const debug = new SensoryDebugService({
    matcher: services.matcher,
    cache: services.semi,
    runtime: services.runtime,
    ledger: services.ledger,
    semipersistentLayer: services.semi,
    bank: services.bank,
    surfaceProjector: services.surface,
    config: {},
  })
  services.runtime.debug = debug
  const session = testSession()
  const exec = { cwd: services.dir, agent: { cwd: services.dir, session } }
  return { ...services, debug, session, exec }
}

function catalogMessage(text) {
  return {
    id: 'catalog',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: '@local/sensory-memory', purpose: 'sensory-catalog' },
  }
}

test('last prompt captures complete system, tools, messages and separates auxiliary requests', (t) => {
  const { debug, exec } = fixture(t)
  debug.captureRequest(Object.freeze({
    sessionId: 's',
    provider: 'fixture',
    system: 'SYSTEM',
    tools: [{ name: 'sensory_open' }],
    messages: Object.freeze([{ role: 'user', content: 'hello' }]),
  }))
  debug.captureRequest({ sessionId: 's', purpose: 'memory-retrieval-plan', system: 'AUX', tools: [], messages: [] }, { auxiliary: true })
  assert.equal(debug.fullPrompt(exec, 'main').capture.request.system, 'SYSTEM')
  assert.equal(debug.fullPrompt(exec, 'main').capture.request.tools[0].name, 'sensory_open')
  assert.equal(debug.fullPrompt(exec, 'auxiliary').capture.purpose, 'memory-retrieval-plan')
})

test('index debug resolves catalog lines to sensoryChunks and exposes vectors', async (t) => {
  const { debug, runtime, ledger, exec } = fixture(t)
  const stored = await runtime.storeSensory('蓝灯塔的档案柜钥匙在绿色盒子里。', exec)
  const chunk = ledger.get('sensoryChunks', stored.chunkIds[0], { scopeKind: 'session', scopeId: 's' })
  const catalog = `（卸载上下文目录）\n<memory-chunks>\n- [[chunk:${chunk.id}]] [sensory] [seq 2-2] 蓝灯塔的档案柜钥匙在绿色盒子里\n</memory-chunks>`
  debug.captureRequest({ sessionId: 's', system: 'system', tools: [], messages: [catalogMessage(catalog)] })
  const view = debug.indexPrompt(exec)
  assert.equal(view.attributes.chunkStore.chunkCount, 1)
  assert.equal(view.entries[0].record.id, chunk.id)
  assert.equal(view.entries[0].record.vector.dimensions, 128)
})

test('working view excludes plugin chunk projections and reports tool pairing', (t) => {
  const { debug, exec } = fixture(t)
  debug.captureRequest({
    sessionId: 's',
    system: 'system',
    tools: [],
    messages: [
      catalogMessage('- [[chunk:x]] [sensory] [seq 1-1] x'),
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', text: 'ok' }] },
      { role: 'user', content: 'real input' },
    ],
  })
  const view = debug.workingPrompt(exec)
  assert.equal(view.attributes.catalogMessagesExcluded, 1)
  assert.deepEqual(view.attributes.unmatchedToolCalls, [])
  assert.deepEqual(view.attributes.unmatchedToolResults, [])
})

test('debug output writes a human-readable document inside the current workspace', (t) => {
  const { debug, exec, dir } = fixture(t)
  const result = JSON.parse(debug.output(debug.fullPrompt(exec), { output: 'document', documentPath: 'audit/chunks.md', title: 'Chunk Audit' }, exec))
  assert.equal(existsSync(result.document.path), true)
  assert.match(readFileSync(result.document.path, 'utf8'), /# Chunk Audit/)
  assert.equal(result.document.path.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/')), true)
})

test('clear alias removes only current session chunks and chunk-only tools register', async (t) => {
  const { debug, runtime, ledger, exec, matcher, semi, bank } = fixture(t)
  await runtime.storeSensory('项目M端口8383', exec)
  const preview = await debug.clearWorkspaceIndex(exec, { confirm: false })
  assert.equal(preview.effectiveTarget, 'current-session-chunks')
  const cleared = await debug.clearWorkspaceIndex(exec, { confirm: true })
  assert.equal(cleared.cleared, true)
  assert.equal(ledger.list('sensoryChunks', { scopeKind: 'session', scopeId: 's' }).length, 0)
  const tools = createSensoryToolDefinitions({ matcher, cache: semi, runtime, ledger, bank, debug })
  assert.equal(tools.some((tool) => tool.name === 'sensory_open' && 'chunk' in tool.parameters.properties), true)
  assert.equal(tools.some((tool) => tool.name === 'sensory_audit'), false)
})

test('llm stream hook is read-only and captures the frozen provider request', (t) => {
  const { runtime, debug, matcher, semi, bank, ledger } = fixture(t)
  const hooks = new Map()
  const ctx = {
    on(name, callback) { hooks.set(name, callback) },
    effect() {},
    tools: { register() { return () => {} } },
    systemPrompt: { context() { return () => {} } },
    logger: { warn() {} },
  }
  installChunkMemory(ctx, {}, { runtime, debug, auxiliaryRequests: new WeakSet(), maintenance: { async drain() { return { ok: true } } }, matcher, cache: semi, bank, ledger })
  const options = Object.freeze({ sessionId: 's', system: 'S', tools: [], messages: Object.freeze([{ role: 'user', content: 'Q' }]) })
  let called = 0
  hooks.get('llm/stream')(options, () => { called += 1; return 'stream' })
  assert.equal(called, 1)
  assert.equal(debug.fullPrompt({ agent: { session: { id: 's' } } }, 'main').capture.request.messages[0].content, 'Q')
})
