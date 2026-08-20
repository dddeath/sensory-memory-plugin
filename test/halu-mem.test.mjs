import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HaluMemAuditor } from '../lib/halu-mem-auditor.js'
import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sensory-audit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return new SensoryIndex(dir)
}

function source(index, seq, text) {
  const sourceRef = { sessionId: 'audit', seq }
  index.writeSource(sourceRef, { text })
  return sourceRef
}

test('HaluMem detects insertion unsupported by source text', async (t) => {
  const index = fixture(t)
  index.addEntity({ name: '项目A', observations: ['项目A的端口是9999'], sourceRef: source(index, 1, '项目A的端口是8081') })
  const result = await new HaluMemAuditor({ index, llm: null }).audit(1)
  assert.equal(result.insertion.length, 1)
  assert.equal(result.insertion[0].entity, '项目A')
})

test('HaluMem detects contradictory observations for the same fact key', async (t) => {
  const index = fixture(t)
  const ref = source(index, 2, '项目A的端口是8081，后来改为8082')
  index.addEntity({ name: '项目A', observations: ['项目A的端口是8081', '项目A的端口是8082'], sourceRef: ref })
  const result = await new HaluMemAuditor({ index, llm: null }).audit(1)
  assert.equal(result.contradiction.length, 1)
  assert.deepEqual(new Set(result.contradiction[0].values), new Set(['8081', '8082']))
})

test('HaluMem detects source facts omitted from the index', async (t) => {
  const index = fixture(t)
  index.addEntity({ name: '项目A', observations: [], sourceRef: source(index, 3, '项目A的部署端口是8081') })
  const result = await new HaluMemAuditor({ index, llm: null }).audit(1)
  assert.equal(result.deletion.length, 1)
  assert.match(result.deletion[0].fact, /8081/)
})

test('pollution above threshold trips circuit breaker and later writes become proposals', async (t) => {
  const index = fixture(t)
  index.addEntity({ name: '项目A', observations: ['项目A的端口是9999'], sourceRef: source(index, 4, '项目A的端口是8081') })
  const auditor = new HaluMemAuditor({ index, llm: null, config: { pollutionThreshold: 0.2 } })
  const audit = await auditor.audit(1)
  const circuit = await auditor.maybeCircuitBreak(audit)
  const before = index.count()
  const proposalId = index.addEntity({ name: '项目B', observations: ['项目B的端口是8082'] })
  assert.equal(circuit.circuitBroken, true)
  assert.equal(index.writeMode, 'propose')
  assert.match(proposalId, /^proposal_/)
  assert.equal(index.count(), before)
})
