import assert from 'node:assert/strict'
import test from 'node:test'

import { installChunkMemory } from '../lib/install-chunk-memory.js'
import { pluginConfigFromEnvironment } from '../lib/plugin-services.js'
import { SensoryMaintenance } from '../lib/sensory-maintenance.js'

test('pressure runtime prepends pre-step so it can reduce pressure before native DSH compaction', () => {
  const listeners = []
  const contexts = []
  const ctx = {
    on(name, listener, options) { listeners.push({ name, listener, options }); return () => {} },
    effect(effect, label) { if (label === 'sensory-memory: parent child context') effect(); return () => {} },
    systemPrompt: { context(value) { contexts.push(value); return () => {} } },
  }
  const services = {
    runtime: { preStep() {}, turnStopping() {}, drainSession() {} },
    debug: { captureRequest() {} },
    auxiliaryRequests: new WeakSet(),
    maintenance: { async drain() { return { ok: true } } },
  }
  installChunkMemory(ctx, {}, services)
  const preStep = listeners.find((row) => row.name === 'agent/pre-step')
  assert.ok(preStep)
  assert.deepEqual(preStep.options, { prepend: true })
  assert.match(contexts[0].text, /计数或汇总问题先枚举/u)
})

test('maintenance reports the enforced session-only sensory scope', () => {
  const maintenance = new SensoryMaintenance({
    runtime: {
      ledger: {},
      status(sessionId) { return { sessionId } },
    },
  })
  const status = maintenance.status('session-1')
  assert.equal(status.indexScope, 'session')
  assert.equal(status.layered.sessionId, 'session-1')
})

test('benchmark can select a visible lexical-only ablation instead of an E5 endpoint', () => {
  const config = pluginConfigFromEnvironment({
    vectorProvider: 'http',
    vectorEndpoint: 'http://127.0.0.1:8765/embed',
    vectorRequired: true,
  }, {
    DSH_MEMORY_VECTOR_PROVIDER: 'none',
    DSH_MEMORY_VECTOR_TIMEOUT_MS: '30000',
    DSH_MEMORY_VECTOR_BATCH_SIZE: '8',
    DSH_MEMORY_TOOL_MODE: 'retrieval-only',
    DSH_MEMORY_RETRIEVAL_TOOL_CALL_LIMIT: '1',
  })
  assert.equal(config.vectorProvider, 'none')
  assert.equal(config.vectorEndpoint, null)
  assert.equal(config.vectorRequired, false)
  assert.equal(config.vectorTimeoutMs, 30000)
  assert.equal(config.vectorBatchSize, 8)
  assert.equal(config.toolMode, 'retrieval-only')
  assert.equal(config.retrievalToolCallLimit, 1)
  assert.equal(config.indexScope, 'session')
})
