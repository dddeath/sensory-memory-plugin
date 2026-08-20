import assert from 'node:assert/strict'
import test from 'node:test'

import { parseLlmJson, Stage4LlmClient } from '../lib/stage4-llm.js'

test('auxiliary client recovers the last structured JSON from reasoning-only streams', async () => {
  const llm = {
    stream: async function *stream() {
      yield { type: 'reasoning-delta', index: 0, text: '先考虑旧格式 {"query":"错误"}，最终使用 ' }
      yield { type: 'reasoning-delta', index: 0, text: '{"query":"项目M的部署端口"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const client = new Stage4LlmClient({
    llm,
    config: { llmProvider: 'mock', llmModel: 'mock', llmReasoningEffort: 'high' },
  })
  const output = await client.complete('rewrite', { purpose: 'sensory-rewrite' })
  assert.equal(parseLlmJson(output).query, '项目M的部署端口')
  assert.equal(client.status().reasoningFallbacks, 1)
})
