import assert from 'node:assert/strict'
import test from 'node:test'

import { activationOf, addAssociation, MemoryPolicy, parseRememberDirective } from '../lib/memory-policy.js'

test('association counts once per item per distinct turn and passive exposure stays absent', () => {
  let record = { id: 'x', sessionId: 's', associations: [] }
  record = addAssociation(record, { turn: 3, sessionId: 's', weight: 1, kind: 'sensory-open', at: 1000 })
  record = addAssociation(record, { turn: 3, sessionId: 's', weight: 1, kind: 'sensory-open', at: 2000 })
  assert.equal(record.associations.length, 1)
  assert.equal(record.associationDeduplicated, true)
  assert.ok(Number.isFinite(activationOf(record.associations, { currentTurn: 3, now: 1000 })))
  record = addAssociation(record, { turn: 3, sessionId: 'other-session', weight: 1, kind: 'sensory-open', at: 2000 })
  assert.equal(record.associations.length, 2)
})

test('remember parser accepts affirmative imperatives and rejects negation, examples, and meta prose', () => {
  assert.deepEqual(parseRememberDirective('记住：项目M的端口是8282'), { content: '项目M的端口是8282', scopeKind: 'workspace', explicit: true })
  assert.equal(parseRememberDirective('请记住全局跨工作区的偏好是蓝色').scopeKind, 'user-global')
  assert.deepEqual(parseRememberDirective('请记住全局跨工作区：通用发布代号是星桥-9'), { content: '通用发布代号是星桥-9', scopeKind: 'user-global', explicit: true })
  assert.equal(parseRememberDirective('不要记住这句话'), null)
  assert.equal(parseRememberDirective('例如用户说“记住端口”'), null)
})

test('pressure triggers working offload while four inactive turns only rank compression candidates', () => {
  const policy = new MemoryPolicy()
  const base = { id: 'seg', sealedAt: 1, turn: 1, openTask: false, pinned: false, associations: [], verifiedSource: true, evidenceQuality: 0.9, durability: 0.9, importance: 0.5 }
  assert.equal(policy.shouldMoveWorkingToSensory(base, { currentTurn: 4 }), false)
  assert.equal(policy.shouldMoveWorkingToSensory(base, { currentTurn: 5 }), false)
  assert.equal(policy.compressionPriority(base, { currentTurn: 5 }).cold, true)
  assert.equal(policy.shouldMoveWorkingToSensory(base, { currentTurn: 5, contextPressure: true }), true)
  const used = addAssociation(addAssociation(base, { turn: 2, sessionId: 's', weight: 1 }), { turn: 7, sessionId: 's', weight: 1 })
  assert.equal(policy.shouldPromoteToSemi(used, { currentTurn: 8 }), true)
  assert.equal(policy.shouldPromoteToSemi({ ...used, evidenceQuality: 0.7 }, { currentTurn: 8 }), false)
  assert.equal(policy.shouldExpireSemi({ ...base, promotedWorkspaceTurn: 1, promotedAt: 1 }, { currentWorkspaceTurn: 13, now: 2 }), true)
  const stillActive = addAssociation({ ...base, promotedWorkspaceTurn: 1, promotedAt: 1 }, {
    turn: 1, workspaceTurn: 1, sessionId: 's', weight: 10, at: 1,
  })
  assert.equal(policy.shouldExpireSemi(stillActive, { currentWorkspaceTurn: 13, now: 2 }), false)
})
