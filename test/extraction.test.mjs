import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ExtractionEngine } from '../lib/extraction-engine.js'

export const CORPUS = [
  { role: 'user', text: '客户#3的偏好色是color-3，请记住。' },
  { role: 'assistant', text: '好的，已记录客户#3偏好color-3，另外客户#5偏好color-5。' },
  { role: 'tool', text: 'RESULT: 项目A的部署端口是8081，因8080被占用。' },
  { role: 'user', text: '部署任务：依赖已安装，待配置端口。' },
]

test('CORPUS entity recall is at least 70 percent with per-session deduplication', () => {
  const extractor = new ExtractionEngine()
  const names = new Set()
  CORPUS.forEach((entry, index) => {
    const extracted = extractor.extractFromText(entry.text, {
      sessionId: 'corpus-session', seq: index + 1, role: entry.role,
    })
    for (const entity of extracted.entities) names.add(entity.name)
  })
  const expected = ['客户#3', '客户#5', '项目A', '端口8081']
  const hits = expected.filter((name) => names.has(name))
  const recall = hits.length / expected.length
  assert.ok(recall >= 0.7, `recall=${recall}; hits=${hits.join(',')}`)
  assert.equal(recall, 1)
})

test('fact templates extract 客户#3偏好color-3 and attach it to the entity', () => {
  const extractor = new ExtractionEngine()
  const result = extractor.extractFromText('已记录客户#3偏好color-3。', {
    sessionId: 'facts', seq: 1, role: 'assistant',
  })
  assert.ok(result.observations.some((item) => item.content === '客户#3偏好color-3'))
  assert.ok(result.entities.find((item) => item.name === '客户#3').observations.includes('客户#3偏好color-3'))
})

test('entity output is deduplicated and keywords are merged', () => {
  const extractor = new ExtractionEngine()
  const result = extractor.extractFromText('客户#3偏好color-3，客户#3的偏好色是color-5。', {
    sessionId: 'dedupe', seq: 1,
  })
  const customers = result.entities.filter((item) => item.name === '客户#3')
  assert.equal(customers.length, 1)
  assert.equal(customers[0].observations.length, 2)
  assert.ok(customers[0].keywords.includes('color-3'))
  assert.ok(customers[0].keywords.includes('color-5'))
})

test('empty and punctuation-only noise inputs return empty collections', () => {
  const extractor = new ExtractionEngine()
  for (const text of ['', '   ', '！！！……']) {
    assert.deepEqual(extractor.extractFromText(text, { sessionId: 'noise', seq: 1 }), {
      entities: [], relations: [], observations: [],
    })
  }
})

test('package has zero declared dependencies and stage-1 entry avoids forbidden integrations', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const entry = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.devDependencies, undefined)
  assert.equal(entry.includes('llm/stream'), false)
  assert.equal(entry.includes('sensory_'), false)
  assert.equal(entry.includes('ctx.tools'), false)
})
