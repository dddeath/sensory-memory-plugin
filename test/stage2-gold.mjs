import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MatchEngine, SensoryIndex } from '../lib/index.js'

const path = mkdtempSync(join(tmpdir(), 'sensory-stage2-gold-'))
try {
  const index = new SensoryIndex(path)
  index.addEntity({ name: '客户#3', observations: ['客户#3的偏好色是color-3'], keywords: ['客户', '偏好色', 'color-3'] })
  index.addEntity({ name: '项目A', observations: ['项目A的部署端口是8081'], keywords: ['项目', '部署', '部署端口', '8081'] })
  index.addEntity({ name: '端口8081', observations: ['端口8081用于项目A部署'], keywords: ['端口', '8081', '部署'] })
  const matcher = new MatchEngine(index)
  const gold = [
    ['客户#3喜欢什么颜色', new Set(['客户#3'])],
    ['项目A部署在哪个端口', new Set(['项目A'])],
    ['部署有什么坑', new Set(['端口8081', '项目A'])],
    ['天气怎么样', new Set([null])],
  ]
  let correct = 0
  const cases = []
  for (const [query, expected] of gold) {
    const result = await matcher.match(query)
    const top1 = result.engrams[0]?.name ?? null
    const passed = expected.has(top1)
    if (passed) correct += 1
    cases.push({ query, expected: [...expected], top1, passed, reason: result.reason })
  }
  const output = { cases, correct, total: gold.length, hitAt1: correct / gold.length }
  console.log(JSON.stringify(output, null, 2))
  if (output.hitAt1 < 0.6) process.exitCode = 1
} finally {
  rmSync(path, { recursive: true, force: true })
}
