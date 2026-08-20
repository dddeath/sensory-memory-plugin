import { NgramHashAddressing } from './hash.js'
import { parseLlmJson } from './stage4-llm.js'

function blockText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return String(message?.text ?? '')
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .filter(Boolean)
    .join(' ')
}

export function recentContextSummary(viewer = {}) {
  if (typeof viewer.recentContext === 'string') return viewer.recentContext.slice(-600)
  const messages = Array.isArray(viewer.messages) ? viewer.messages : []
  return messages
    .filter((message) => (
      (message?.role === 'user' || message?.role === 'assistant')
      && !['plugin', 'tool'].includes(message?.source?.kind)
    ))
    .slice(-4)
    .map((message) => `${message.role}:${blockText(message)}`)
    .join('\n')
    .slice(-600)
}

function entrySeqs(hits = []) {
  return hits.flatMap((hit) => hit.source_refs ?? [])
    .map((ref) => ref?.seq)
    .filter((seq) => seq !== undefined && seq !== null)
}

function rewriteIntent(queryText) {
  const query = String(queryText ?? '')
  if (/(?:端口|监听|多少号)/.test(query)) return '部署端口'
  return query.replace(/[，。！？!?]/g, ' ').trim().slice(0, 40)
}

function contextualEntity(context, availableNames) {
  const candidates = []
  for (const name of availableNames) {
    const index = String(context).lastIndexOf(name)
    if (index >= 0) candidates.push({ name, index })
  }
  for (const match of String(context).matchAll(/(?:项目|代号)\s*([A-Z])/gi)) {
    const name = `项目${match[1].toUpperCase()}`
    if (availableNames.includes(name)) candidates.push({ name, index: match.index ?? -1 })
  }
  return candidates.sort((left, right) => right.index - left.index)[0]?.name ?? null
}

function normalizeRewrite(output, parsed, { queryText, context, availableNames }) {
  const rawStructured = parsed?.query ?? parsed?.rewrittenQuery ?? parsed?.rewrite
  const metaPattern = /(?:我们根据|按要求|复述规则|只输出|键名|输入是|上下文提到|但这是关于)/
  const contextName = contextualEntity(context, availableNames)
  const hasCoreference = /(?:它|那个|上次|此前|之前)/.test(String(queryText ?? ''))
  const clean = (value) => String(value ?? '')
    .replace(/^```\w*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'`]|["'`]$/g, '')
    .replace(/^改写(?:结果|查询)?[：:]\s*/, '')
    .trim()

  const structured = clean(rawStructured)
  if (structured && structured !== '改写结果' && structured.length <= 100 && !metaPattern.test(structured)) {
    if (contextName && hasCoreference && !structured.includes(contextName)) {
      return `${contextName} ${rewriteIntent(queryText)}`.trim()
    }
    return structured
  }

  const outputText = String(output ?? '')
  const plain = clean(outputText)
  if (plain.length <= 100 && !metaPattern.test(plain) && availableNames.some((name) => plain.includes(name))) {
    if (contextName && hasCoreference && !plain.includes(contextName)) {
      return `${contextName} ${rewriteIntent(queryText)}`.trim()
    }
    return plain
  }
  const outputName = availableNames
    .map((name) => ({ name, index: outputText.lastIndexOf(name) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => right.index - left.index)[0]?.name
  const name = contextName ?? outputName
  if (name) return `${name} ${rewriteIntent(queryText)}`.trim()

  const lines = outputText.split(/\r?\n/).map(clean).filter(Boolean)
  return [...lines].reverse().find((line) => line.length <= 100 && !metaPattern.test(line)) ?? ''
}

export class FallbackRewriter {
  constructor({ matcher, llm, config = {} }) {
    this.matcher = matcher
    this.llm = llm
    this.enabled = config.rewriterEnabled !== false && config.fallbackRewriteEnabled !== false && Boolean(llm)
    this.config = {
      cacheSize: Math.max(1, config.rewriteCacheSize ?? config.cacheSize ?? 50),
      scoreThreshold: config.rewriteScoreThreshold ?? config.scoreThreshold ?? 0.3,
      attemptedTurnLimit: Math.max(10, config.attemptedTurnLimit ?? 200),
    }
    this.hasher = new NgramHashAddressing()
    this.cache = new Map()
    this.attemptedTurns = new Map()
    this.stats = {
      attempts: 0,
      llmCalls: 0,
      cacheHits: 0,
      rewriteHits: 0,
      misses: 0,
      failures: 0,
      totalDurationMs: 0,
      last: null,
    }
  }

  fingerprint(queryText, viewer = {}) {
    const scopeId = String(viewer.scopeId ?? viewer.sessionId ?? 'global')
    const material = `${scopeId}\n${String(queryText ?? '').trim()}\n${recentContextSummary(viewer)}`.toLowerCase()
    const slots = this.hasher.slotKeys(this.hasher.hash(material)).sort()
    return `${material.length}:${slots.join('|')}`
  }

  #rememberAttempt(turnKey) {
    if (!turnKey) return
    this.attemptedTurns.delete(turnKey)
    this.attemptedTurns.set(turnKey, Date.now())
    while (this.attemptedTurns.size > this.config.attemptedTurnLimit) {
      this.attemptedTurns.delete(this.attemptedTurns.keys().next().value)
    }
  }

  #cacheSet(key, rewrittenQuery, scopeId = 'global') {
    this.cache.delete(key)
    this.cache.set(key, { rewrittenQuery, scopeId: String(scopeId), cachedAt: Date.now() })
    while (this.cache.size > this.config.cacheSize) this.cache.delete(this.cache.keys().next().value)
  }

  async #match(queryText, viewer) {
    if (typeof this.matcher.matchSync === 'function') {
      const result = this.matcher.matchSync(queryText, viewer)
      const low = Number.isFinite(result?.topScore) && result.topScore < this.config.scoreThreshold
      return low ? { ...result, engrams: [], lowConfidence: true } : result
    }
    return await this.matcher.match(queryText, viewer) ?? { engrams: [] }
  }

  async maybeRewrite(queryText, viewer = {}) {
    if (!this.enabled || !String(queryText ?? '').trim()) return null
    const started = performance.now()
    const fingerprint = this.fingerprint(queryText, viewer)
    const turnKey = viewer.turnKey ? String(viewer.turnKey) : null
    this.stats.attempts += 1
    try {
      const cached = this.cache.get(fingerprint)
      if (cached) {
        this.cache.delete(fingerprint)
        this.cache.set(fingerprint, cached)
        this.stats.cacheHits += 1
        const result = await this.#match(cached.rewrittenQuery, viewer)
        const hits = result.engrams ?? []
        const value = hits.length === 0 ? null : {
          rewrittenQuery: cached.rewrittenQuery,
          hits,
          entrySeqs: entrySeqs(hits),
          fromCache: true,
          fingerprint,
        }
        this.stats.last = value ?? { rewrittenQuery: cached.rewrittenQuery, fromCache: true, fingerprint, hit: false }
        return value
      }
      if (turnKey && this.attemptedTurns.has(turnKey)) return null
      this.#rememberAttempt(turnKey)

      const context = recentContextSummary(viewer)
      const scopeId = this.matcher.scopeFor?.(viewer) ?? viewer.scopeId ?? 'global'
      const availableNames = this.matcher.sensoryIndex?.all?.(scopeId)
        .sort((left, right) => (right.last_hit_at ?? right.valid_from ?? 0) - (left.last_hit_at ?? left.valid_from ?? 0))
        .slice(0, 12)
        .map((entity) => entity.name)
        ?? []
      const available = availableNames.join('、')
      const prompt = `把检索词改写成具体、极短的记忆查询。只输出一个JSON对象，唯一键名为query，值必须是具体查询；不要复述规则。可用入口：${available}。上下文：${context.slice(-400)}\n检索词：${String(queryText).slice(0, 300)}`
      this.stats.llmCalls += 1
      const output = await this.llm.complete(prompt, {
        system: '你是记忆检索改写器。只输出一行具体查询。',
        maxTokens: 256,
        purpose: 'sensory-rewrite',
        sessionId: viewer.sessionId,
      })
      const parsed = parseLlmJson(output)
      const rewrittenQuery = normalizeRewrite(output, parsed, {
        queryText,
        context,
        availableNames,
      })
        .slice(0, 300)
      if (!rewrittenQuery) throw new Error('rewriter returned empty query')
      const result = await this.#match(rewrittenQuery, viewer)
      const hits = result.engrams ?? []
      if (hits.length === 0) {
        this.stats.misses += 1
        this.stats.last = { rewrittenQuery, fromCache: false, fingerprint, hit: false }
        return null
      }
      this.#cacheSet(fingerprint, rewrittenQuery, this.matcher.scopeFor?.(viewer) ?? viewer.scopeId ?? 'global')
      this.stats.rewriteHits += 1
      const value = {
        rewrittenQuery,
        hits,
        entrySeqs: entrySeqs(hits),
        fromCache: false,
        fingerprint,
      }
      this.stats.last = { ...value, hits: hits.map((hit) => hit.name) }
      return value
    } catch (error) {
      this.stats.failures += 1
      this.stats.last = { fingerprint, error: String(error), hit: false }
      return null
    } finally {
      this.stats.totalDurationMs += performance.now() - started
    }
  }

  dropScope(scopeId) {
    const scope = String(scopeId)
    let removed = 0
    for (const [key, value] of [...this.cache]) if (value.scopeId === scope) { this.cache.delete(key); removed += 1 }
    for (const key of [...this.attemptedTurns.keys()]) if (key.includes(scope)) this.attemptedTurns.delete(key)
    return { scopeId: scope, removed }
  }

  status() {
    return {
      ...this.stats,
      cacheEntries: this.cache.size,
      enabled: this.enabled,
      triggerRate: (this.matcher?.stats?.queries ?? 0) === 0
        ? 0
        : this.stats.attempts / this.matcher.stats.queries,
      averageDurationMs: this.stats.attempts === 0 ? 0 : this.stats.totalDurationMs / this.stats.attempts,
    }
  }
}
