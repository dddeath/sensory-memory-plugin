import { randomUUID } from 'node:crypto'

function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value?.text === 'string') return value.text
  if (typeof value?.content === 'string') return value.content
  return value
}

export function parseLlmJson(value) {
  if (value && typeof value === 'object') return value
  const text = String(value ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const parsed = []
    for (let start = 0; start < text.length; start += 1) {
      if (text[start] !== '{' && text[start] !== '[') continue
      const stack = []
      let quoted = false
      let escaped = false
      for (let index = start; index < text.length; index += 1) {
        const character = text[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') quoted = false
          continue
        }
        if (character === '"') { quoted = true; continue }
        if (character === '{' || character === '[') stack.push(character)
        if (character === '}' || character === ']') {
          const opening = stack.pop()
          if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) break
          if (stack.length === 0) {
            try { parsed.push(JSON.parse(text.slice(start, index + 1))) } catch {}
            break
          }
        }
      }
    }
    return parsed.at(-1) ?? null
  }
}

export class Stage4LlmClient {
  constructor({ llm, config = {}, auxiliaryRequests = new WeakSet() } = {}) {
    this.llm = llm
    this.auxiliaryRequests = auxiliaryRequests
    this.provider = config.llmProvider ?? config.stage4Provider ?? config.provider ?? null
    this.model = config.llmModel ?? config.stage4Model ?? config.model ?? null
    this.reasoningEffort = config.llmReasoningEffort ?? 'high'
    this.enabled = config.llmEnabled !== false && Boolean(llm)
    this.stats = {
      calls: 0,
      failures: 0,
      totalDurationMs: 0,
      byPurpose: {},
      lastError: null,
      reasoningFallbacks: 0,
    }
  }

  async complete(prompt, { system = '', maxTokens = 256, purpose = 'stage4', sessionId, reasoningEffort = this.reasoningEffort } = {}) {
    if (!this.enabled) throw new Error('stage4 llm is disabled')
    const started = performance.now()
    this.stats.calls += 1
    this.stats.byPurpose[purpose] = (this.stats.byPurpose[purpose] ?? 0) + 1
    try {
      if (typeof this.llm?.complete === 'function') {
        return textOf(await this.llm.complete(String(prompt), { system, maxTokens, purpose, sessionId }))
      }
      if (typeof this.llm?.stream !== 'function') throw new Error('ctx.llm.stream is unavailable')
      if (!this.provider || !this.model) throw new Error('stage4 llm provider/model are not configured')
      const options = {
        provider: this.provider,
        model: this.model,
        messages: [{
          id: `sensory_${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: String(prompt) }],
          source: { kind: 'plugin', plugin: '@local/sensory-memory' },
        }],
        system: String(system),
        maxTokens,
        purpose,
        sourcePlugin: '@local/sensory-memory',
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
      this.auxiliaryRequests.add(options)
      let text = ''
      let reasoning = ''
      try {
        for await (const chunk of this.llm.stream(options)) {
          if (chunk?.type === 'text-delta') text += chunk.text ?? ''
          if (chunk?.type === 'reasoning-delta') reasoning += chunk.text ?? ''
          if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk?.reason?.kind)) {
            throw new Error(chunk.reason?.failure?.message ?? `stage4 llm ${chunk.reason.kind}`)
          }
        }
      } finally {
        this.auxiliaryRequests.delete(options)
      }
      if (!text.trim() && reasoning.trim()) {
        this.stats.reasoningFallbacks += 1
        this.stats.lastOutputPreview = reasoning.trim().slice(-500)
        return reasoning.trim()
      }
      if (!text.trim()) throw new Error('stage4 llm returned no text or reasoning')
      this.stats.lastOutputPreview = text.trim().slice(-500)
      return text.trim()
    } catch (error) {
      this.stats.failures += 1
      this.stats.lastError = String(error)
      throw error
    } finally {
      this.stats.totalDurationMs += performance.now() - started
    }
  }

  status() {
    return {
      ...this.stats,
      averageDurationMs: this.stats.calls === 0 ? 0 : this.stats.totalDurationMs / this.stats.calls,
      provider: this.provider,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      enabled: this.enabled,
    }
  }
}
