import assert from 'node:assert/strict'
import test from 'node:test'

import { FallbackRewriter, recentContextSummary } from '../lib/fallback-rewriter.js'

function hit() {
  return { id: 'e-project-m', name: '项目M', summary: '项目M的部署端口是8282', source_refs: [{ sessionId: 's', seq: 58 }] }
}

function matcher({ rewrittenHits = true } = {}) {
  const run = (query) => ({ engrams: query.includes('项目M') && rewrittenHits ? [hit()] : [] })
  return {
    sensoryIndex: {
      all: () => [{ name: '项目M', valid_from: 2 }, { name: '项目A', valid_from: 1 }],
    },
    matchSync: run,
    match: async (query) => run(query),
  }
}

test('empty algorithm result is recovered after the gold LLM rewrite', async () => {
  const rewriter = new FallbackRewriter({
    matcher: matcher(),
    llm: { complete: async () => '项目M的部署端口' },
  })
  const result = await rewriter.maybeRewrite('上次那个项目的端口', { recentContext: '此前讨论项目M', turnKey: 't1' })
  assert.equal(result.rewrittenQuery, '项目M的部署端口')
  assert.equal(result.hits[0].name, '项目M')
  assert.equal(result.entrySeqs[0], 58)
})

test('same fingerprint reuses cached rewrite and calls the LLM once', async () => {
  let calls = 0
  const rewriter = new FallbackRewriter({
    matcher: matcher(),
    llm: { complete: async () => { calls += 1; return '项目M的部署端口' } },
  })
  const viewer = { recentContext: '此前讨论项目M' }
  const first = await rewriter.maybeRewrite('上次那个项目的端口', { ...viewer, turnKey: 't1' })
  const second = await rewriter.maybeRewrite('上次那个项目的端口', { ...viewer, turnKey: 't2' })
  assert.equal(calls, 1)
  assert.equal(first.fromCache, false)
  assert.equal(second.fromCache, true)
})

test('rewrite that still has no hit preserves zero injection', async () => {
  const rewriter = new FallbackRewriter({
    matcher: matcher({ rewrittenHits: false }),
    llm: { complete: async () => '不存在的项目端口' },
  })
  assert.equal(await rewriter.maybeRewrite('上次那个项目', { turnKey: 't1' }), null)
  assert.equal(rewriter.status().misses, 1)
})

test('reasoning prose is normalized with the contextual project instead of stored as a query', async () => {
  const rewriter = new FallbackRewriter({
    matcher: matcher(),
    llm: { complete: async () => '我们根据要求：只输出JSON对象，键名query。输入是“它监听多少号”，但这是关于什么的？' },
  })
  const result = await rewriter.maybeRewrite('它监听多少号？', {
    recentContext: 'user:隔离补救上下文：代号M代表此前部署对象。\nassistant:收到啦',
    turnKey: 't-reasoning',
  })
  assert.equal(result.rewrittenQuery, '项目M 部署端口')
  assert.equal(result.hits[0].name, '项目M')
})

test('ambiguous structured rewrite is grounded to the contextual entity', async () => {
  const rewriter = new FallbackRewriter({
    matcher: matcher(),
    llm: { complete: async () => '{"query":"M监听端口"}' },
  })
  const result = await rewriter.maybeRewrite('它监听多少号？', {
    recentContext: 'user:代号M代表此前部署对象\nassistant:收到啦',
    turnKey: 't-structured',
  })
  assert.equal(result.rewrittenQuery, '项目M 部署端口')
  assert.deepEqual(result.hits.map((entry) => entry.name), ['项目M'])
})

test('recent context excludes plugin snapshots so the previous human referent survives', () => {
  const context = recentContextSummary({
    messages: [
      { role: 'user', source: { kind: 'user' }, content: '代号M代表此前部署对象' },
      { role: 'user', source: { kind: 'plugin' }, content: 'x'.repeat(800) },
      { role: 'assistant', content: '收到啦' },
      { role: 'user', source: { kind: 'user' }, content: '它监听多少号？' },
    ],
  })
  assert.match(context, /代号M/)
  assert.doesNotMatch(context, /x{100}/)
})
