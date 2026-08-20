function pendingCandidate(result, demoter, index, scopeId) {
  const items = (result?.results ?? []).filter((entry) => entry?.demoted).map((entry) => {
    const tracked = demoter.state.tracked.find((item) => item.key === entry.key)
    return { ...entry, text: tracked?.text ?? '', entities: entry.entityIds.map((id) => index.get(id, scopeId)).filter(Boolean) }
  })
  if (items.length === 0) return null
  return {
    text: items.map((item) => item.text).filter(Boolean).join('\n---\n'),
    entityIds: [...new Set(items.flatMap((item) => item.entityIds))],
    sourceRef: items.at(-1)?.sourceRef,
    scopeId,
  }
}

export class SensoryMaintenance {
  constructor({ index, demoter, matcher, llmExtractor, cache, rewriter, config = {} }) {
    this.index = index
    this.demoter = demoter
    this.matcher = matcher
    this.llmExtractor = llmExtractor
    this.cache = cache
    this.rewriter = rewriter
    this.indexScope = config.indexScope === 'session' ? 'session' : 'global'
    this.stats = { drains: 0, finalized: 0, dropped: 0, timeouts: 0, failures: 0 }
  }

  scopeFor(sessionId) {
    return this.indexScope === 'session' ? String(sessionId ?? 'global') : 'global'
  }

  async drain(sessionId = null, { timeoutMs = 30_000 } = {}) {
    const started = performance.now()
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(1, timeoutMs)) })
    try {
      const settled = await Promise.race([this.llmExtractor.drain(sessionId), timeout])
      if (settled?.timeout) {
        this.stats.timeouts += 1
        return { ok: false, timeout: true, sessionId, durationMs: performance.now() - started }
      }
      this.index.flush()
      this.stats.drains += 1
      return { ok: true, timeout: false, sessionId, settled, durationMs: performance.now() - started }
    } catch (error) {
      this.stats.failures += 1
      return { ok: false, timeout: false, sessionId, error: String(error), durationMs: performance.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }

  async finalizeSession(sessionId) {
    const scopeId = this.scopeFor(sessionId)
    const result = await this.demoter.finalizeSession(sessionId)
    const candidate = pendingCandidate(result, this.demoter, this.index, scopeId)
    if (candidate) await this.llmExtractor.settle([candidate])
    const drained = await this.drain(scopeId)
    this.matcher.markDirty?.()
    this.matcher.warm?.()
    this.stats.finalized += 1
    return { sessionId: String(sessionId), scopeId, demotion: result, drained }
  }

  async dropScope(sessionId) {
    const scopeId = this.scopeFor(sessionId)
    if (scopeId === 'global') return { scopeId, retained: true }
    const drained = await this.drain(scopeId)
    const before = {
      index: this.index.stats(scopeId),
      cache: this.cache.status?.(scopeId) ?? null,
    }
    const cache = this.cache.dropScope?.(scopeId) ?? null
    const rewrite = this.rewriter.dropScope?.(scopeId) ?? null
    const tracked = this.demoter.dropScope(sessionId)
    const index = this.index.dropScope(scopeId)
    this.matcher.markDirty?.()
    this.matcher.warm?.()
    this.stats.dropped += 1
    return { scopeId, before, drained, cache, rewrite, tracked, index }
  }

  status() {
    return { ...this.stats, indexScope: this.indexScope, extractor: this.llmExtractor.status?.() ?? null }
  }
}

export { pendingCandidate }
