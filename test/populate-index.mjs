import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

import { ExtractionEngine } from '../lib/extraction-engine.js'
import { SensoryIndex } from '../lib/sensory-index.js'

const CORPUS = [
  { role: 'user', text: '客户#3的偏好色是color-3，请记住。' },
  { role: 'assistant', text: '好的，已记录客户#3偏好color-3，另外客户#5偏好color-5。' },
  { role: 'tool', text: 'RESULT: 项目A的部署端口是8081，因8080被占用。' },
  { role: 'user', text: '部署任务：依赖已安装，待配置端口。' },
]

const requested = process.argv[2]
const indexDir = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), 'sensory-inspect-'))
const extractor = new ExtractionEngine()
const index = new SensoryIndex(indexDir)
const names = new Set()

for (const [offset, entry] of CORPUS.entries()) {
  const sourceRef = { sessionId: 'stage1-corpus', seq: offset + 1 }
  index.writeSource(sourceRef, entry)
  const extracted = extractor.extractFromText(entry.text, { ...sourceRef, role: entry.role })
  for (const entity of extracted.entities) {
    names.add(entity.name)
    index.addEntity(entity)
  }
}
index.flush()

const expected = ['客户#3', '客户#5', '项目A', '端口8081']
const hits = expected.filter((name) => names.has(name))
process.stdout.write(`${JSON.stringify({
  indexDir,
  expected,
  hits,
  recall: hits.length / expected.length,
  entityCount: index.count(),
  files: ['entities.jsonl', 'relations.jsonl', 'observations.jsonl', 'rounds.json'],
}, null, 2)}\n`)
