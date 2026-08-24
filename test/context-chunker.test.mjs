import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { ContextChunker } from '../lib/context-chunker.js'
import { cosineSimilarity, FeatureHashVectorEncoder, HttpVectorEncoder } from '../lib/vector-encoder.js'

test('short text becomes one authoritative parent with one embedded child span', () => {
  const chunker = new ContextChunker()
  const encoder = new FeatureHashVectorEncoder({ dimensions: 64 })
  const chunks = chunker.chunk('蓝灯塔的档案柜钥匙在绿色盒子里。', { segmentId: 'seg-1' })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].id, 'seg-1:parent:001')
  assert.equal(chunks[0].kind, 'context-parent')
  assert.equal(chunks[0].childSpans.length, 1)
  const vector = encoder.encodeSync(chunks[0].childSpans[0].embeddingText)
  assert.equal(vector.values.length, 64)
  assert.equal(vector.model, 'feature-hash-cjk-v1')
})

test('long text has non-overlapping parent cores and overlap only in child embedding text', () => {
  const markers = Array.from({ length: 24 }, (_, index) => `唯一句子${String(index).padStart(2, '0')}：这是用于验证切分边界的内容。`)
  const chunks = new ContextChunker({ parentMaxTokens: 400, parentTargetTokens: 320, childMaxTokens: 80, childTargetTokens: 64, childOverlapTokens: 12 }).chunk(markers.join('\n'), { segmentId: 'long' })
  assert.equal(chunks.length > 1, true)
  for (const marker of markers) {
    assert.equal(chunks.filter((chunk) => chunk.coreText.includes(marker)).length, 1)
  }
  const children = chunks.flatMap((chunk) => chunk.childSpans.map((child) => ({ parent: chunk, child })))
  assert.equal(children.length > chunks.length, true)
  assert.equal(children.some(({ parent, child }) => child.embeddingText.length > parent.coreText.slice(child.startOffset, child.endOffset).length), true)
  assert.equal(children.every(({ child }) => child.overlap.factsFromCoreOnly), true)
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
  assert.match(rows[0].childSpans[0].embeddingText, /\| 项目 \| 端口 \|/)
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

test('MemGym-style document markers create hard Parent boundaries', () => {
  const observation = [
    '=== Turn 1: compare projects ===',
    '',
    '--- Document Alpha ---',
    '',
    'ALPHA-17 uses the northern archive.',
    '',
    '--- Document Beta ---',
    '',
    'BETA-29 uses the southern archive.',
  ].join('\n')
  const parents = new ContextChunker().chunkParents(observation, { segmentId: 'turn-1' })
  assert.deepEqual(parents.map((parent) => parent.documentTitle), ['Document Alpha', 'Document Beta'])
  assert.equal(parents.some((parent) => parent.coreText.includes('ALPHA-17') && parent.coreText.includes('BETA-29')), false)
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
      assert.equal(payload.protocol, 'dsh-embedding-sidecar/1')
      assert.equal(payload.kind, 'passage')
      response.end(JSON.stringify({ protocol: 'dsh-embedding-sidecar/1', model: payload.model, revision: payload.revision, dimensions: 3, normalized: true, vectors: payload.texts.map((_, index) => [index + 1, 1, 0]) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  const encoder = new HttpVectorEncoder({ endpoint: `http://127.0.0.1:${port}/embed`, model: 'test/e5', revision: 'test-revision', dimensions: 3 })
  const vectors = await encoder.encodeBatch(['第一段', '第二段'])
  assert.equal(vectors.length, 2)
  assert.equal(vectors[0].model, 'test/e5')
  assert.equal(vectors[0].dimensions, 3)
})
