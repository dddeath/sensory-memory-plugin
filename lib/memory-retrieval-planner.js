import { parseLlmJson } from './stage4-llm.js'

function normalizePlan(value) {
  return {
    resolvedQuery: String(value?.resolvedQuery ?? '').trim().slice(0, 300),
    entityHints: Array.isArray(value?.entityHints) ? value.entityHints.map(String).slice(0, 8) : [],
    timeConstraint: {
      kind: ['current', 'asOf', 'range'].includes(value?.timeConstraint?.kind) ? value.timeConstraint.kind : 'current',
      from: value?.timeConstraint?.from ?? null,
      to: value?.timeConstraint?.to ?? null,
    },
    selectedCandidateIds: Array.isArray(value?.selectedCandidateIds) ? value.selectedCandidateIds.map(String).slice(0, 8) : [],
    needOpen: Boolean(value?.needOpen),
    confidence: Math.max(0, Math.min(1, Number(value?.confidence ?? 0))),
  }
}

export class MemoryRetrievalPlanner {
  constructor({ matcher, llm, config = {} }) {
    this.matcher = matcher
    this.llm = llm
    this.enabled = config.memoryRetrievalPlannerEnabled !== false && Boolean(llm)
    this.cache = new Map()
    this.attemptedSteps = new Set()
    this.cacheSize = Math.max(1, config.memoryRetrievalPlanCacheSize ?? 100)
    this.stats = { attempts: 0, llmCalls: 0, cacheHits: 0, verifiedHits: 0, failures: 0, zeroEvidence: 0, byPurpose: { 'memory-retrieval-plan': 0 } }
  }

  key(result, viewer = {}) {
    return JSON.stringify([
      String(viewer.sessionId),
      String(viewer.taskStateRevision ?? '0'),
      String(result.query),
      result.candidates.map((item) => item.id),
    ])
  }

  async plan(result, viewer = {}) {
    if (result.sufficient || !this.enabled) return null
    const stepKey = `${viewer.sessionId}:${viewer.turn ?? 0}:${viewer.step ?? 0}`
    if (this.attemptedSteps.has(stepKey)) return null
    this.attemptedSteps.add(stepKey)
    if (this.attemptedSteps.size > 500) this.attemptedSteps.delete(this.attemptedSteps.values().next().value)
    const key = this.key(result, viewer)
    this.stats.attempts += 1
    let plan = this.cache.get(key)
    const fromCache = Boolean(plan)
    if (plan) this.stats.cacheHits += 1
    try {
      if (!plan) {
        this.stats.llmCalls += 1
        this.stats.byPurpose['memory-retrieval-plan'] += 1
        const candidates = result.candidates.slice(0, 32).map((item) => ({
          id: item.id,
          layer: item.layer,
          title: item.title,
          facts: item.canonicalFacts,
          episode: item.episodeSummary,
          score: item.relevance,
          evidenceQuality: item.evidenceQuality,
        }))
        const output = await this.llm.complete(
          `Resolve the query into a retrieval plan. Select only IDs in candidates. Do not answer the question. Return one JSON object with resolvedQuery, entityHints, timeConstraint:{kind,current|asOf|range,from,to}, selectedCandidateIds, needOpen, confidence.\nQuery:${result.query}\nReasons:${result.slowPathReasons.join(',')}\nCandidates:${JSON.stringify(candidates)}`,
          { system: 'You are a conservative memory retrieval planner. You choose evidence IDs but never create facts.', maxTokens: 256, purpose: 'memory-retrieval-plan', sessionId: viewer.sessionId },
        )
        plan = normalizePlan(parseLlmJson(output))
        const allowed = new Set(result.candidates.map((item) => item.id))
        plan.selectedCandidateIds = plan.selectedCandidateIds.filter((id) => allowed.has(id))
        this.cache.set(key, plan)
        while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value)
      }
      const verified = this.matcher.verifySelected(result, plan.selectedCandidateIds, plan)
      if (verified.verified) this.stats.verifiedHits += 1
      else this.stats.zeroEvidence += 1
      return { plan, ...verified, fromCache }
    } catch (error) {
      this.stats.failures += 1
      return { plan: null, selected: [], verified: false, error: String(error) }
    }
  }

  dropSession(sessionId) {
    const prefix = JSON.stringify([String(sessionId)]).slice(0, -1)
    let removed = 0
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) { this.cache.delete(key); removed += 1 }
    for (const key of [...this.attemptedSteps]) if (key.startsWith(`${sessionId}:`)) this.attemptedSteps.delete(key)
    return { sessionId: String(sessionId), removed }
  }

  status() { return { ...this.stats, enabled: this.enabled, cacheEntries: this.cache.size, attemptedSteps: this.attemptedSteps.size } }
}
