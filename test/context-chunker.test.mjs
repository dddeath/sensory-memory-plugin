import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { ContextChunker } from '../lib/context-chunker.js'
import { cosineSimilarity, FeatureHashVectorEncoder, HttpVectorEncoder } from '../lib/vector-encoder.js'

test('short text becomes exactly one chunk and one vector', () => {
  const chunker = new ContextChunker()
  const encoder = new FeatureHashVectorEncoder({ dimensions: 64 })
  const chunks = chunker.chunk('蓝灯塔的档案柜钥匙在绿色盒子里。', { segmentId: 'seg-1' })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].id, 'seg-1:chunk:001')
  const vector = encoder.encodeSync(chunks[0].contextText)
  assert.equal(vector.values.length, 64)
  assert.equal(vector.model, 'feature-hash-cjk-v1')
})

test('long text has non-overlapping core chunks and overlap only in vector context', () => {
  const markers = Array.from({ length: 24 }, (_, index) => `唯一句子${String(index).padStart(2, '0')}：这是用于验证切分边界的内容。`)
  const chunks = new ContextChunker({ chunkMaxTokens: 80, chunkOverlapTokens: 12 }).chunk(markers.join('\n'), { segmentId: 'long' })
  assert.equal(chunks.length > 1, true)
  for (const marker of markers) {
    assert.equal(chunks.filter((chunk) => chunk.coreText.includes(marker)).length, 1)
  }
  assert.equal(chunks.some((chunk) => chunk.contextText.length > chunk.coreText.length), true)
  assert.equal(chunks.every((chunk) => chunk.overlap.factsFromCoreOnly), true)
})

test('Markdown headings remain metadata and table rows remain atomic cores', () => {
  const markdown = `# 项目手册

## 端口

| 项目 | 端口 |
| --- | --- |
| M | 8282 |
| N | 8383 |
`
  const chunks = new ContextChunker({ chunkMaxTokens: 80 }).chunk(markdown, { segmentId: 'md' })
  const rows = chunks.filter((chunk) => chunk.format === 'markdown-table')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].headingPath, ['项目手册', '端口'])
  assert.equal(rows[0].coreText, '| M | 8282 |\n| N | 8383 |')
  assert.equal(rows[0].rowCount, 2)
  assert.match(rows[0].contextText, /\| 项目 \| 端口 \|/)
  assert.equal(rows[0].coreText.split('\n').every((line) => /^\|.+\|$/.test(line)), true)
})

test('fenced JavaScript and Python are split at function or class boundaries', () => {
  const markdown = [
    '# code',
    '```javascript',
    'function alpha() { return 1 }',
    'function beta() { return 2 }',
    '```',
    '',
    '```python',
    'def first():',
    '    return 1',
    'class Second:',
    '    pass',
    '```',
  ].join('\n')
  const chunks = new ContextChunker({ chunkMaxTokens: 200 }).chunk(markdown, { segmentId: 'code' })
  assert.equal(chunks.some((chunk) => chunk.coreText.startsWith('function alpha')), true)
  assert.equal(chunks.some((chunk) => chunk.coreText.startsWith('function beta')), true)
  assert.equal(chunks.some((chunk) => chunk.coreText.startsWith('def first')), true)
  assert.equal(chunks.some((chunk) => chunk.coreText.startsWith('class Second')), true)
})

test('feature vectors rank related chunks above unrelated chunks without a third-party dependency', () => {
  const encoder = new FeatureHashVectorEncoder({ dimensions: 384 })
  const query = encoder.encodeSync('蓝灯塔钥匙在哪里')
  const related = encoder.encodeSync('蓝灯塔的档案柜钥匙位于绿色盒子')
  const unrelated = encoder.encodeSync('今天的天气和音乐播放列表')
  assert.equal(cosineSimilarity(query.values, related.values) > cosineSimilarity(query.values, unrelated.values), true)
})

test('HTTP vector adapter accepts a local small-model sidecar contract', async (t) => {
  const server = http.createServer((request, response) => {
    const body = []
    request.on('data', (chunk) => body.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(body).toString('utf8'))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ vectors: payload.texts.map((_, index) => [index + 1, 1, 0]) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  const encoder = new HttpVectorEncoder({ endpoint: `http://127.0.0.1:${port}/embed`, model: 'BAAI/bge-small-zh-v1.5' })
  const vectors = await encoder.encodeBatch(['第一段', '第二段'])
  assert.equal(vectors.length, 2)
  assert.equal(vectors[0].model, 'BAAI/bge-small-zh-v1.5')
  assert.equal(vectors[0].dimensions, 3)
})
