import { NgramHashAddressing } from './hash.js'
import {
  createStopwords,
  generateCandidates,
  lexicalTokens,
  normalizeRetrievalText,
  scoreCandidate,
  toLayeredCandidate,
} from './layered-match-support.js'

const SENSORY = 'sensoryEntries'

function candidateRanking(left, right) {
  return right.effectiveRelevance - left.effectiveRelevance
    || Number(right.exact) - Number(left.exact)
    || left.title.localeCompare(right.title)
}

function mergedLayerRanking(left, right) {
  return right.relevance - left.relevance || left.title.localeCompare(right.title)
}

function lastResultStatus(result) {
  if (!result) return null
  return {
    query: result.query,
    topScore: result.topScore,
    bestRawScore: result.bestRawScore,
    bestQualifiedScore: result.bestQualifiedScore,
    margin: result.margin,
    sufficient: result.sufficient,
    slowPathReasons: result.slowPathReasons,
    generatedCandidateCount: result.generatedCandidateCount,
    eligibleCandidateCount: result.eligibleCandidateCount,
    qualifiedCandidateCount: result.qualifiedCandidateCount,
    summaryOnlyCandidateCount: result.summaryOnlyCandidateCount,
    sourceAnchoredCandidateCount: result.sourceAnchoredCandidateCount,
    sourceValidationRejectedCount: result.sourceValidationRejectedCount,
    bestRawCandidate: result.bestRawCandidate,
  }
}

export class LayeredMatchEngine {
  constructor({ ledger, bank, sourceReader = null, config = {} }) {
    this.ledger = ledger
    this.bank = bank
    this.hasher = new NgramHashAddressing()
    this.sourceReader = typeof sourceReader === 'function' ? sourceReader : null
    this.config = {
      candidateLimit: Math.max(1, config.candidateLimit ?? 32),
      catalogLimit: Math.max(1, config.evidenceCatalogLimit ?? 3),
      relevanceThreshold: Number(config.relevanceThreshold ?? 0.70),
      evidenceQualityThreshold: Number(config.evidenceQualityThreshold ?? 0.80),
      ambiguityMargin: Number(config.ambiguityMargin ?? 0.15),
      stopwords: createStopwords(config.memoryStopwords ?? []),
      trustedEvidenceTools: new Set((config.trustedEvidenceTools ?? []).map(String)),
    }
    this.stats = {
      queries: 0,
      sensoryQueries: 0,
      bankQueries: 0,
      hardRejected: 0,
      slowPathRecommended: 0,
      zeroEvidence: 0,
      generatedCandidates: 0,
      qualifiedCandidates: 0,
      sourceAnchoredCandidates: 0,
      sourceValidationRejected: 0,
      resolvedQueryRechecks: 0,
    }
    this.lastResult = null
  }

  sensoryEntries(sessionId) {
    return this.ledger.list(SENSORY, { scopeKind: 'session', scopeId: sessionId })
      .map((record) => toLayeredCandidate(record, 'sensory'))
  }

  bankEntries(workspaceId, includeUserGlobal = true) {
    return this.bank.listVisible({ workspaceId, includeUserGlobal })
      .map((record) => toLayeredCandidate(record, 'bank'))
  }

  #score(query, taskState, candidate) {
    const scored = scoreCandidate(query, taskState, candidate, this.config, this.sourceReader)
    if (!scored.eligibility.ok) this.stats.hardRejected += 1
    if (scored.summaryOnly && scored.matchedRetrievalTerms.length > 0 && !scored.sourceValidation.ok) {
      this.stats.sourceValidationRejected += 1
    }
    return scored
  }

  #rank(query, taskState, records) {
    const generated = generateCandidates(query, records, {
      hasher: this.hasher,
      candidateLimit: this.config.candidateLimit,
      stopwords: this.config.stopwords,
    })
    return generated.map((candidate) => this.#score(query, taskState, candidate)).sort(candidateRanking)
  }

  retrieve(query, { sessionId, workspaceId, taskState = {}, includeUserGlobal = true } = {}) {
    if (!String(sessionId ?? '').trim()) throw new TypeError('sessionId is required')
    this.stats.queries += 1
    this.stats.sensoryQueries += 1

    let ranked = this.#rank(query, taskState, this.sensoryEntries(sessionId))
    let qualified = ranked.filter((item) => item.qualified)
    let searchedBank = false
    if (qualified.length === 0) {
      searchedBank = true
      this.stats.bankQueries += 1
      ranked = [...ranked, ...this.#rank(query, taskState, this.bankEntries(workspaceId, includeUserGlobal))].sort(mergedLayerRanking)
      qualified = ranked.filter((item) => item.qualified)
    }

    const bestRaw = ranked[0]
    const top = qualified[0]
    const second = qualified[1]
    const margin = top ? top.relevance - (second?.relevance ?? 0) : 0
    const duplicateExact = qualified.filter((item) => item.exact && normalizeRetrievalText(item.title) === normalizeRetrievalText(top?.title)).length > 1
    const uniqueExactVerified = Boolean(top?.exact && !duplicateExact && (top.canonicalFacts.length > 0 || top.sourceDirect))
    const coreference = /\b(?:it|that|this|previous|last)\b|(?:它|那个|上次|此前|之前)/iu.test(String(query))
    const temporalQuery = /(?:截至|现在|当前|当时|之前|之后|何时|什么时候|as\s+of|currently|before|after|when)/iu.test(String(query))
    const summaryWithoutAnswer = Boolean(bestRaw?.summaryOnly && !bestRaw.sourceDirect)
    const candidateConflict = ranked.some((item) => item.conflict)
    const sufficient = Boolean(top
      && (uniqueExactVerified || margin >= this.config.ambiguityMargin)
      && !coreference
      && !temporalQuery
      && !summaryWithoutAnswer
      && !candidateConflict)
    const slowPathReasons = this.#slowPathReasons({ top, margin, uniqueExactVerified, duplicateExact, coreference, temporalQuery, summaryWithoutAnswer, candidateConflict, bestRaw })

    if (!sufficient) this.stats.slowPathRecommended += 1
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
      bestQualifiedScore: top?.relevance ?? 0,
      margin,
      sufficient,
      slowPathReasons,
      searchedBank,
      generatedCandidateCount: ranked.length,
      eligibleCandidateCount: ranked.filter((item) => item.eligibility.ok).length,
      qualifiedCandidateCount: qualified.length,
      summaryOnlyCandidateCount: ranked.filter((item) => item.summaryOnly).length,
      sourceAnchoredCandidateCount: ranked.filter((item) => item.sourceEvidenceScore > 0).length,
      sourceValidationRejectedCount: ranked.filter((item) => item.summaryOnly && item.matchedRetrievalTerms.length > 0 && !item.sourceValidation.ok).length,
      bestRawCandidate: bestRaw ? {
        id: bestRaw.id,
        title: bestRaw.title,
        baseRelevance: bestRaw.baseRelevance,
        sourceEvidenceScore: bestRaw.sourceEvidenceScore,
        effectiveRelevance: bestRaw.effectiveRelevance,
        qualified: bestRaw.qualified,
        summaryOnly: bestRaw.summaryOnly,
        sourceValidation: bestRaw.sourceValidation,
        matchedRetrievalTerms: bestRaw.matchedRetrievalTerms,
      } : null,
    }
    this.stats.generatedCandidates += result.generatedCandidateCount
    this.stats.qualifiedCandidates += result.qualifiedCandidateCount
    this.stats.sourceAnchoredCandidates += result.sourceAnchoredCandidateCount
    this.lastResult = result
    return result
  }

  #slowPathReasons({ top, margin, uniqueExactVerified, duplicateExact, coreference, temporalQuery, summaryWithoutAnswer, candidateConflict, bestRaw }) {
    const reasons = []
    if (!top) reasons.push('no-qualified-candidate')
    if (top && margin < this.config.ambiguityMargin && !uniqueExactVerified) reasons.push('low-margin')
    if (duplicateExact) reasons.push('duplicate-exact-alias')
    if (coreference) reasons.push('coreference')
    if (temporalQuery) reasons.push('temporal-constraint')
    if (summaryWithoutAnswer) reasons.push('checkpoint-summary-without-answer')
    if (candidateConflict) reasons.push('conflict')
    if (bestRaw?.summaryOnly && bestRaw.sourceValidation?.ok === false && bestRaw.sourceValidation.reason !== 'no-retrieval-anchor') {
      reasons.push(bestRaw.sourceValidation.reason)
    }
    return [...new Set(reasons)]
  }

  verifySelected(result, selectedIds, planContext = {}) {
    const allowed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]))
    const resolvedQuery = [planContext.resolvedQuery, ...(planContext.entityHints ?? [])]
      .map(String).map((value) => value.trim()).filter(Boolean).join(' ') || result.query
    this.stats.resolvedQueryRechecks += 1
    const selected = [...new Set(selectedIds ?? [])]
      .map((id) => allowed.get(String(id)))
      .filter(Boolean)
      .map((candidate) => this.#score(resolvedQuery, {}, candidate))
      .filter((candidate) => candidate.eligibility.ok
        && candidate.effectiveRelevance >= this.config.relevanceThreshold
        && (!candidate.summaryOnly || candidate.sourceDirect))
      .slice(0, this.config.catalogLimit)
    const margin = selected[0] ? selected[0].relevance - (selected[1]?.relevance ?? 0) : 0
    const verified = selected.length > 0
      && (selected[0].exact || selected[0].sourceDirect || margin >= this.config.ambiguityMargin)
    return { selected, verified, margin, resolvedQuery }
  }

  renderCatalog(selected = []) {
    if (!selected.length) return null
    const entries = selected.slice(0, this.config.catalogLimit)
    const lines = entries.map((item) => {
      const fact = item.canonicalFacts.find((candidate) => candidate.current !== false)
      const summary = fact ? `${fact.subject} ${fact.predicate} ${fact.value}` : item.episodeSummary
      return `- [[${item.title}]] [${item.layer}] ${summary}`
    })
    const prompt = `（记忆证据目录：只包含已通过来源和质量门的当前会话感知条目或记忆库条目；需要原文时使用 sensory_open 或 memory_bank_open。）\n<memory>\n${lines.join('\n')}\n</memory>`
    return { prompt, entries, estimatedTokens: Math.ceil(prompt.length / 2) }
  }

  status() {
    return {
      ...this.stats,
      config: {
        ...this.config,
        stopwords: this.config.stopwords.size,
        trustedEvidenceTools: this.config.trustedEvidenceTools.size,
      },
      lastResult: lastResultStatus(this.lastResult),
    }
  }
}

export { lexicalTokens }
export { SENSORY as SENSORY_LEDGER_COLLECTION }
