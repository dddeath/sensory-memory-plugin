import {
  createStopwords,
  generateCandidates,
  lexicalTokens,
  scoreCandidate,
  toLayeredCandidate,
} from './layered-match-support.js'

const SENSORY = 'sensoryChunks'

function candidateRanking(left, right) {
  return right.effectiveRelevance - left.effectiveRelevance
    || Number(right.raw.updatedAt ?? 0) - Number(left.raw.updatedAt ?? 0)
    || left.id.localeCompare(right.id)
}

function lastResultStatus(result) {
  if (!result) return null
  return {
    query: result.query,
    topScore: result.topScore,
    bestRawScore: result.bestRawScore,
    margin: result.margin,
    sufficient: result.sufficient,
    needsPlanner: result.needsPlanner,
    slowPathReasons: result.slowPathReasons,
    generatedCandidateCount: result.generatedCandidateCount,
    qualifiedCandidateCount: result.qualifiedCandidateCount,
    vectorCandidateCount: result.vectorCandidateCount,
    bestRawCandidate: result.bestRawCandidate,
  }
}

export class LayeredMatchEngine {
  constructor({ ledger, bank, vectorEncoder = null, sourceReader = null, config = {} }) {
    this.ledger = ledger
    this.bank = bank
    this.vectorEncoder = vectorEncoder
    this.sourceReader = typeof sourceReader === 'function' ? sourceReader : null
    this.config = {
      candidateLimit: Math.max(1, config.candidateLimit ?? 32),
      catalogLimit: Math.max(1, config.evidenceCatalogLimit ?? 3),
      relevanceThreshold: Number(config.relevanceThreshold ?? 0.70),
      evidenceQualityThreshold: Number(config.evidenceQualityThreshold ?? 0.80),
      ambiguityMargin: Number(config.ambiguityMargin ?? 0.15),
      vectorCandidateThreshold: Number(config.vectorCandidateThreshold ?? 0.18),
      plannerCandidateFloor: Number(config.plannerCandidateFloor ?? 0.45),
      stopwords: createStopwords(config.memoryStopwords ?? []),
    }
    this.stats = {
      queries: 0,
      sensoryQueries: 0,
      bankQueries: 0,
      hardRejected: 0,
      slowPathRecommended: 0,
      plannerSkippedNoCandidates: 0,
      plannerSkippedWeakCandidates: 0,
      zeroEvidence: 0,
      generatedCandidates: 0,
      qualifiedCandidates: 0,
      vectorCandidates: 0,
      sourceValidationRejected: 0,
      resolvedQueryRechecks: 0,
    }
    this.lastResult = null
  }

  sensoryChunks(sessionId) {
    return this.ledger.list(SENSORY, { scopeKind: 'session', scopeId: sessionId })
      .filter((record) => !record.tombstonedAt && record.temporalCurrent !== false && !record.supersededBy)
      .map((record) => toLayeredCandidate(record, 'sensory'))
  }

  bankChunks(workspaceId, includeUserGlobal = true) {
    return this.bank.listVisible({ workspaceId, includeUserGlobal })
      .map((record) => toLayeredCandidate(record, 'bank'))
  }

  #rank(query, records, queryVector) {
    const generated = generateCandidates(query, records, {
      candidateLimit: this.config.candidateLimit,
      stopwords: this.config.stopwords,
      queryVector,
      vectorCandidateThreshold: this.config.vectorCandidateThreshold,
    })
    return generated.map((candidate) => {
      const scored = scoreCandidate(query, candidate, this.config, this.sourceReader, queryVector)
      if (!scored.eligibility.ok) this.stats.hardRejected += 1
      if (!scored.sourceValidation.ok) this.stats.sourceValidationRejected += 1
      return scored
    }).sort(candidateRanking)
  }

  #retrieveWithVector(query, viewer, queryVector) {
    const { sessionId, workspaceId, includeUserGlobal = true } = viewer
    if (!String(sessionId ?? '').trim()) throw new TypeError('sessionId is required')
    this.stats.queries += 1
    this.stats.sensoryQueries += 1
    let ranked = this.#rank(query, this.sensoryChunks(sessionId), queryVector)
    let qualified = ranked.filter((item) => item.qualified)
    let searchedBank = false
    if (qualified.length === 0) {
      searchedBank = true
      this.stats.bankQueries += 1
      ranked = [...ranked, ...this.#rank(query, this.bankChunks(workspaceId, includeUserGlobal), queryVector)].sort(candidateRanking)
      qualified = ranked.filter((item) => item.qualified)
    }

    const top = qualified[0] ?? null
    const independentSecond = qualified.find((item) => item.segmentId !== top?.segmentId) ?? null
    const margin = top ? top.relevance - (independentSecond?.relevance ?? 0) : 0
    const coreference = /\b(?:it|that|this|previous|last)\b|(?:它|那个|上次|此前|之前)/iu.test(String(query))
    const temporalQuery = /(?:截至|现在|当前|当时|之前|之后|何时|什么时候|as\s+of|currently|before|after|when)/iu.test(String(query))
    const candidateConflict = ranked.some((item) => item.conflict)
    const uniqueQualified = qualified.length === 1 || !independentSecond
    const sufficient = Boolean(top
      && (uniqueQualified || margin >= this.config.ambiguityMargin)
      && !coreference
      && !candidateConflict
      && (!temporalQuery || (uniqueQualified && top.temporalCurrent)))
    const slowPathReasons = []
    const bestRaw = ranked[0] ?? null
    const plausibleWeakCandidate = Boolean(bestRaw && (
      ((coreference || temporalQuery) && bestRaw.relevance >= this.config.vectorCandidateThreshold)
      || (bestRaw.relevance >= this.config.plannerCandidateFloor && bestRaw.lexicalRelevance >= 0.35)
    ))
    if (!top && plausibleWeakCandidate) slowPathReasons.push('no-qualified-chunk')
    if (top && !uniqueQualified && margin < this.config.ambiguityMargin) slowPathReasons.push('low-margin')
    if (coreference) slowPathReasons.push('coreference')
    if (temporalQuery && !(uniqueQualified && top?.temporalCurrent)) slowPathReasons.push('temporal-ambiguity')
    if (candidateConflict) slowPathReasons.push('conflict')
    const needsPlanner = !sufficient && ranked.length > 0 && slowPathReasons.length > 0
    if (!sufficient && needsPlanner) this.stats.slowPathRecommended += 1
    if (!sufficient && ranked.length === 0) this.stats.plannerSkippedNoCandidates += 1
    if (!sufficient && ranked.length > 0 && !needsPlanner) this.stats.plannerSkippedWeakCandidates += 1
    if (qualified.length === 0) this.stats.zeroEvidence += 1

    const result = {
      query: String(query),
      sessionId: String(sessionId),
      workspaceId: String(workspaceId),
      candidates: ranked.slice(0, this.config.candidateLimit),
      qualified,
      selected: sufficient ? qualified.slice(0, this.config.catalogLimit) : [],
      topScore: top?.relevance ?? 0,
      bestRawScore: bestRaw?.relevance ?? 0,
      margin,
      sufficient,
      needsPlanner,
      slowPathReasons,
      searchedBank,
      generatedCandidateCount: ranked.length,
      qualifiedCandidateCount: qualified.length,
      vectorCandidateCount: ranked.filter((item) => item.generatedBy?.vector).length,
      bestRawCandidate: bestRaw ? {
        id: bestRaw.id,
        label: bestRaw.label,
        lexicalRelevance: bestRaw.lexicalRelevance,
        vectorRelevance: bestRaw.vectorRelevance,
        effectiveRelevance: bestRaw.effectiveRelevance,
        qualified: bestRaw.qualified,
        sourceValidation: bestRaw.sourceValidation,
      } : null,
    }
    this.stats.generatedCandidates += result.generatedCandidateCount
    this.stats.qualifiedCandidates += result.qualifiedCandidateCount
    this.stats.vectorCandidates += result.vectorCandidateCount
    this.lastResult = result
    return result
  }

  retrieve(query, viewer = {}) {
    const queryVector = typeof this.vectorEncoder?.encodeSync === 'function'
      ? this.vectorEncoder.encodeSync(String(query))
      : null
    return this.#retrieveWithVector(query, viewer, queryVector)
  }

  async retrieveAsync(query, viewer = {}) {
    const queryVector = this.vectorEncoder ? await this.vectorEncoder.encode(String(query)) : null
    return this.#retrieveWithVector(query, viewer, queryVector)
  }

  async verifySelected(result, selectedIds, planContext = {}) {
    const allowed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]))
    const resolvedQuery = [planContext.resolvedQuery, ...(planContext.chunkHints ?? [])]
      .map(String).map((value) => value.trim()).filter(Boolean).join(' ') || result.query
    this.stats.resolvedQueryRechecks += 1
    const queryVector = this.vectorEncoder ? await this.vectorEncoder.encode(resolvedQuery) : null
    const selected = [...new Set(selectedIds ?? [])]
      .map((id) => allowed.get(String(id)))
      .filter(Boolean)
      .map((candidate) => scoreCandidate(resolvedQuery, candidate, this.config, this.sourceReader, queryVector))
      .filter((candidate) => candidate.qualified)
      .sort(candidateRanking)
      .slice(0, this.config.catalogLimit)
    const independentSecond = selected.find((item) => item.segmentId !== selected[0]?.segmentId)
    const margin = selected[0] ? selected[0].relevance - (independentSecond?.relevance ?? 0) : 0
    const verified = selected.length > 0 && (!independentSecond || margin >= this.config.ambiguityMargin)
    return { selected, verified, margin, resolvedQuery }
  }

  renderCatalog(selected = []) {
    if (!selected.length) return null
    const entries = selected.slice(0, this.config.catalogLimit)
    const lines = entries.map((item) => {
      const excerpt = item.coreText.replace(/\s+/g, ' ').slice(0, 240)
      const seq = item.sourceRefs.map((ref) => ref.seq).filter(Number.isFinite)
      return `- [[chunk:${item.id}]] [${item.layer}] [seq ${seq[0] ?? '?'}-${seq.at(-1) ?? '?'}] ${excerpt}`
    })
    const prompt = `（卸载上下文目录：每项都是可追溯的 context chunk；目录曝光不计关联。需要完整原文时使用 sensory_open(chunk)。）\n<memory-chunks>\n${lines.join('\n')}\n</memory-chunks>`
    return { prompt, entries, estimatedTokens: Math.ceil(prompt.length / 2) }
  }

  status() {
    return {
      ...this.stats,
      architecture: 'chunk-only-vector',
      config: {
        ...this.config,
        stopwords: this.config.stopwords.size,
      },
      vectorEncoder: this.vectorEncoder?.status?.() ?? null,
      lastResult: lastResultStatus(this.lastResult),
    }
  }
}

export { lexicalTokens }
export { SENSORY as SENSORY_LEDGER_COLLECTION }
