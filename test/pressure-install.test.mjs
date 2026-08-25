import assert from 'node:assert/strict'
import test from 'node:test'

import { installChunkMemory } from '../lib/install-chunk-memory.js'

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
