import assert from 'node:assert/strict'
import test from 'node:test'

import { SurfaceBudgetController } from '../lib/surface-budget-controller.js'

function parent(id, firstSeq, label, extras = {}) {
  return {
    id,
    parentIndex: 0,
    firstSeq,
    lastSeq: firstSeq + 3,
    label,
    documentTitle: label,
    evidenceQuality: 0.9,
    associations: [],
    surfaceResidency: 'labeled-pointer',
    pointer: { pointerId: `p${firstSeq}`, contentTokens: 24, estimatedTokens: 24 },
    ...extras,
  }
}

test('pointer budget controller progressively uses compact and ID-only modes until budget is met', () => {
  const controller = new SurfaceBudgetController({ pointerMaxTokens: 24, compactPointerMaxTokens: 12 })
  const result = controller.plan([
    parent('old', 1, '项目M生产发布端口8383'),
    parent('middle', 20, '负责人林澄与备用代号CEDAR-9'),
    parent('hot', 40, '当前任务关键记录', { pinned: true }),
  ], { budgetTokens: 32 })
  assert.equal(result.targetReached, true)
  assert.equal(result.finalTokens <= 32, true)
  assert.equal(result.actions.length > 0, true)
  assert.equal(result.actions[0].parentId, 'old')
  assert.equal(result.actions.some((action) => action.to === 'compact-pointer'), true)
  assert.equal(result.actions.some((action) => action.to === 'id-pointer'), true)
  assert.equal(result.actions.every((action) => action.savedTokens > 0), true)
})

test('compact pointer keeps high-information numbers and mixed identifiers', () => {
  const controller = new SurfaceBudgetController({ compactPointerMaxTokens: 12 })
  const result = controller.plan([
    parent('release', 5, '项目M生产发布端口8383备用代号CEDAR-9'),
  ], { budgetTokens: 12 })
  const compact = result.actions.find((action) => action.to === 'compact-pointer')
  assert.ok(compact)
  assert.match(compact.rendered.label, /项目M|8383|CEDAR/u)
  assert.equal(compact.rendered.estimatedTokens <= 12, true)
})

