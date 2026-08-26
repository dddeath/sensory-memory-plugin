import assert from 'node:assert/strict'
import test from 'node:test'

import { installChunkMemory } from '../lib/install-chunk-memory.js'
import { SensoryMaintenance } from '../lib/sensory-maintenance.js'

test('pressure runtime prepends pre-step so it can reduce pressure before native DSH compaction', () => {
  const listeners = []
  const ctx = {
    on(name, listener, options) { listeners.push({ name, listener, options }); return () => {} },
    effect() { return () => {} },
    systemPrompt: { context() { return () => {} } },
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
