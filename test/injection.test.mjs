import assert from 'node:assert/strict'
import test from 'node:test'

import {
  estimateTokens,
  extractQuery,
  InjectionEngine,
  protectToolPairBoundary,
} from '../lib/injection-engine.js'

function engine(options = {}) {
  return new InjectionEngine({
    matcher: options.matcher ?? { match: async () => ({ engrams: [] }) },
    session: options.session,
    config: options.config,
  })
}

test('renderCatalog sorts mixed hits by source seq and emits the v3 catalog format', () => {
  const injector = engine()
  const catalog = injector.renderCatalog([
    { name: '项目A', summary: '项目A的部署端口是8081', source_refs: [{ seq: 260 }] },
    { name: '客户#3', summary: '客户#3的偏好色是color-3', source_refs: [{ seq: 100 }] },
  ])
  assert.ok(catalog.indexOf('[[客户#3]]') < catalog.indexOf('[[项目A]]'))
  assert.match(catalog, /<memory>[\s\S]*<\/memory>/)
  assert.match(catalog, /\[\[客户#3\]\] \[seq 100\]/)
  assert.match(catalog, /sensory_open/)
  assert.match(catalog, /sensory_recall/)
})

test('renderCatalog enforces budget and maxCatalogPerTurn', () => {
  const injector = engine({ config: { injectBudgetTokens: 150, maxCatalogPerTurn: 2 } })
  const hits = Array.from({ length: 5 }, (_, index) => ({
    name: `项目${String.fromCharCode(65 + index)}`,
    summary: `项目${String.fromCharCode(65 + index)}的摘要${'很长'.repeat(80)}`,
    source_refs: [{ seq: index + 1 }],
  }))
  const catalog = injector.renderCatalog(hits)
  assert.ok(estimateTokens(catalog) <= 150)
  assert.ok((catalog.match(/^-/gm) ?? []).length <= 2)
})

test('matchAndRender returns null when matcher has no hit', async () => {
  const injector = engine()
  assert.equal(await injector.matchAndRender('完全无关'), null)
  assert.deepEqual(injector.lastResult.entrySeqs, [])
})

test('locateInsertIndex uses message seq and session event-to-message mapping', () => {
  const session = {
    id: 's1',
    events: [
      { seq: 80, type: 'user/message', data: { id: 'm1' } },
      { seq: 140, type: 'assistant/message', data: { message: { id: 'm2' } } },
    ],
  }
  const injector = engine({ session })
  assert.equal(injector.locateInsertIndex([{ seq: 20 }, { seq: 120 }, { seq: 180 }], 100), 1)
  assert.equal(injector.locateInsertIndex([{ id: 'm1' }, { id: 'm2' }], 100, 's1'), 1)
  assert.equal(injector.locateInsertIndex([{ id: 'unknown' }], 100), null)
})

test('inject restores the catalog into the middle and preserves later message order', () => {
  const injector = engine()
  const messages = [
    { role: 'user', seq: 10, content: '先前' },
    { role: 'assistant', seq: 20, content: '随后' },
    { role: 'user', seq: 30, content: '当前' },
  ]
  const index = injector.inject(messages, '<memory>entry</memory>', [15])
  assert.equal(index, 1)
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[1].source.kind, 'plugin')
  assert.equal(messages[1].content[0].text, '<memory>entry</memory>')
  assert.deepEqual(messages.slice(2).map((message) => message.seq), [20, 30])
  assert.equal(injector.lastInjection.fallback, false)
  assert.equal(injector.lastInjection.toolBoundaryAdjusted, false)
})

test('inject never splits an assistant tool-call from all corresponding tool results', () => {
  const injector = engine()
  const messages = [
    { role: 'user', seq: 10, content: [{ type: 'text', text: '开始' }] },
    {
      role: 'assistant',
      seq: 58,
      content: [
        { type: 'tool-call', id: 'call-1', name: 'sensory_open' },
        { type: 'tool-call', id: 'call-2', name: 'sensory_status' },
      ],
    },
    {
      role: 'user',
      seq: 59,
      source: { kind: 'tool', callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [] }],
    },
    {
      role: 'user',
      seq: 60,
      source: { kind: 'tool', callId: 'call-2' },
      content: [{ type: 'tool-result', toolCallId: 'call-2', content: [] }],
    },
    { role: 'assistant', seq: 61, content: [{ type: 'text', text: '完成' }] },
  ]

  assert.equal(protectToolPairBoundary(messages, 2), 4)
  const index = injector.inject(messages, '<memory>safe</memory>', [58])
  assert.equal(injector.lastInjection.proposedIndex, 2)
  assert.equal(index, 4)
  assert.equal(injector.lastInjection.toolBoundaryAdjusted, true)
  assert.deepEqual(messages.slice(1, 5).map((message) => message.role), [
    'assistant', 'user', 'user', 'user',
  ])
  assert.equal(messages[4].source.kind, 'plugin')
})

test('incomplete historical tool groups move the catalog before the assistant call', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '开始' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'missing', name: 'x' }] },
    { role: 'user', content: [{ type: 'text', text: '后续用户消息' }] },
  ]
  assert.equal(protectToolPairBoundary(messages, 2), 1)
})

test('extractQuery joins last user with last assistant text and excludes non-text blocks', () => {
  const query = extractQuery({ messages: [
    { role: 'assistant', content: [{ type: 'text', text: '上一轮回答' }, { type: 'tool-call', name: 'bash' }] },
    { role: 'user', content: [{ type: 'text', text: '当前问题' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: '内部推理' }, { type: 'tool-call', name: 'x' }] },
  ] })
  assert.equal(query, '当前问题 上一轮回答')
})

test('matchAndRender enriches public hits from the sensory index with source refs', async () => {
  const matcher = {
    sensoryIndex: { get: () => ({ source_refs: [{ seq: 77 }], observations: ['事实'] }) },
    match: async () => ({ engrams: [{ id: 'e1', name: '项目A', summary: '事实' }] }),
  }
  const injector = engine({ matcher })
  const catalog = await injector.matchAndRender('项目A')
  assert.match(catalog, /\[\[项目A\]\] \[seq 77\]/)
  assert.deepEqual(injector.lastResult.entrySeqs, [77])
})

test('matchAndRenderSync supports the synchronous llm stream contract', () => {
  const matcher = {
    sensoryIndex: { get: () => null },
    match: async () => ({ engrams: [] }),
    matchSync: () => ({ engrams: [{ name: '项目S', summary: '端口8181', source_refs: [{ seq: 18 }] }] }),
  }
  const injector = engine({ matcher })
  assert.match(injector.matchAndRenderSync('项目S'), /\[\[项目S\]\] \[seq 18\]/)
  assert.equal(typeof injector.lastResult.durationMs, 'number')
})
