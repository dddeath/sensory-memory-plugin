import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryTransitionReviewer } from '../lib/memory-transition-reviewer.js'

test('transition review is low-frequency, evidence bounded, and uses the dedicated purpose', async () => {
  const calls = []
  const reviewer = new MemoryTransitionReviewer({ llm: { async complete(_prompt, options) { calls.push(options); return JSON.stringify({ action: 'bank', scopeKind: 'workspace', memoryType: 'decision', content: '项目M的发布门是双人复核', importance: 0.95, durability: 0.95, evidenceQuality: 1, boundaryReason: 'decision', confidence: 0.92 }) } } })
  assert.equal(reviewer.shouldReview({ userText: '今天天气很好', verifiedSource: true }), false)
  const decision = await reviewer.review({ sessionId: 's', userText: '项目M发布必须双人复核，这个决定要不要记住？', verifiedSource: true, evidenceQuality: 0.85, memoryType: 'verified-fact', boundaryReason: 'turn-complete' })
  assert.equal(decision.action, 'bank')
  assert.equal(decision.evidenceQuality, 0.85)
  assert.equal(calls[0].purpose, 'memory-transition-review')
})

test('low-confidence transition advice is deterministically rejected', async () => {
  const reviewer = new MemoryTransitionReviewer({ llm: { async complete() { return JSON.stringify({ action: 'bank', confidence: 0.4 }) } } })
  const decision = await reviewer.review({ sessionId: 's', userText: '这个偏好是否要记住？', verifiedSource: true, evidenceQuality: 0.9, memoryType: 'preference' })
  assert.equal(decision.action, 'none')
})
