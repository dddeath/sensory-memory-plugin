import { NgramHashAddressing } from './hash.js'

const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'llm', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'user', 'was', 'were', 'with',
])

const POLLUTION = new Set(['in', 'to', 'on', 'a', 'user', 'llm'])
const SENSORY = 'sensoryEntries'

function normalize(value) { return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase() }

export function lexicalTokens(value) {
  const text = normalize(value)
  const result = new Set()
  for (const match of text.matchAll(/[a-z][\w-]*|\d+/g)) result.add(match[0])
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    result.add(run)
    for (let width = 2; width <= 4; width += 1) {
      for (let index = 0; index + width <= run.length; index += 1) result.add(run.slice(index, index + width))
    }
  }
  return result
}

function badToken(value, stopwords) {
  const text = normalize(value)
  if (!text) return true
  if (POLLUTION.has(text) || stopwords.has(text)) return true
  if (/^[a-z]$/i.test(text)) return true
  if (/^(?:https?:\/\/|[a-z]:\\|\/[^\s]+|\.\.?\/)/iu.test(text)) return true
  if (/[{}<>]=>|\b(?:const|let|var|function|npm|node|scm=)\b/iu.test(text)) return true
  return false
}

function exactBoundary(query, value) {
  const q = normalize(query)
  const needle = normalize(value)
  if (!needle) return false
  if (/^[a-z0-9_-]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i').test(q)
  }
  return q.includes(needle)
}

function coverage(queryTokens, values) {
  const material = new Set(values.flatMap((value) => [...lexicalTokens(value)]))
  const informative = [...queryTokens].filter((token) => !DEFAULT_STOPWORDS.has(token) && !badToken(token, DEFAULT_STOPWORDS))
  if (informative.length === 0) return 0
  return informative.filter((token) => material.has(token)).length / informative.length
}

function sourceRefs(record) { return record.sourceRefs ?? record.source_refs ?? [] }

function evidenceSourceRefs(record) { return record.evidenceSourceRefs ?? record.evidence_source_refs ?? [] }

function sourceText(value) {
  if (typeof value === 'string') return value
  return String(value?.text ?? value?.content ?? '')
}

function sharedToken(queryTokens, value, stopwords) {
  const material = lexicalTokens(value)
  return [...queryTokens]
    .filter((token) => material.has(token) && !badToken(token, stopwords))
    .filter((token) => (/^[\u4e00-\u9fff]+$/u.test(token) ? token.length >= 2 : /^\d+$/.test(token) ? token.length >= 2 : token.length >= 3))
    .sort((left, right) => right.length - left.length)[0] ?? null
}

function scoreMatchedTerms(matched) {
  const full = matched.some((item) => item.matchType === 'full')
  const strong = matched.some((item) => {
    const token = String(item.token ?? '')
    return /^[\u4e00-\u9fff]+$/u.test(token) ? token.length >= 3 : token.length >= 3 || /^\d{2,}$/.test(token)
  })
  const score = full ? 1 : matched.length >= 2 && strong ? 0.8 : matched.length >= 1 ? 0.35 : 0
  return { score, matched, full, strong }
}

function retrievalEvidence(query, terms, stopwords) {
  const queryTokens = lexicalTokens(query)
  const matched = []
  for (const term of terms ?? []) {
    const value = String(term?.value ?? '').trim()
    if (!value || badToken(value, stopwords)) continue
    const full = exactBoundary(query, value)
    const token = full ? value : sharedToken(queryTokens, value, stopwords)
    if (!full && !token) continue
    matched.push({ value, kind: term.kind ?? 'term', sourceRefs: term.sourceRefs ?? [], matchType: full ? 'full' : 'partial', token })
  }
  return scoreMatchedTerms(matched)
}

function candidateView(record, layer) {
  const facts = record.canonicalFacts ?? []
  const title = record.title ?? facts[0]?.subject ?? record.entity ?? record.name ?? record.id
  return {
    id: record.id,
    layer,
    title,
    name: title,
    aliases: record.aliases ?? [],
    retrievalTerms: record.retrievalTerms ?? [],
    evidenceSourceRefs: evidenceSourceRefs(record),
    canonicalFacts: facts,
    episodeSummary: record.episodeSummary ?? record.episode ?? '',
    sourceRefs: sourceRefs(record),
    source_refs: sourceRefs(record),
    evidenceQuality: Number(record.evidenceQuality ?? (record.verifiedSource ? 0.9 : 0)),
    conflict: Boolean(record.conflict || record.unresolvedConflict),
    temporalCurrent: record.temporalCurrent !== false && !facts.some((fact) => fact.current === false && fact.validTo === null),
    raw: record,
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
      stopwords: new Set([...DEFAULT_STOPWORDS, ...(config.memoryStopwords ?? []).map(normalize)]),
      trustedEvidenceTools: new Set((config.trustedEvidenceTools ?? []).map(String)),
    }
    this.stats = { queries: 0, sensoryQueries: 0, bankQueries: 0, hardRejected: 0, slowPathRecommended: 0, zeroEvidence: 0, generatedCandidates: 0, qualifiedCandidates: 0, sourceAnchoredCandidates: 0, sourceValidationRejected: 0, resolvedQueryRechecks: 0 }
    this.lastResult = null
  }

  sensoryEntries(sessionId) {
    return this.ledger.list(SENSORY, { scopeKind: 'session', scopeId: sessionId }).map((record) => candidateView(record, 'sensory'))
  }

  bankEntries(workspaceId, includeUserGlobal = true) {
    return this.bank.listVisible({ workspaceId, includeUserGlobal }).map((record) => candidateView(record, 'bank'))
  }

  #eligible(candidate) {
    if (badToken(candidate.title, this.config.stopwords)) return { ok: false, reason: 'generic-or-code-title' }
    if (candidate.raw.qualityFlags?.includes?.('QUESTION_WITHOUT_ANSWER')) return { ok: false, reason: 'question-without-answer' }
    if (candidate.sourceRefs.length === 0) return { ok: false, reason: 'no-source-refs' }
    if (candidate.evidenceQuality < this.config.evidenceQualityThreshold) return { ok: false, reason: 'low-evidence-quality' }
    if (candidate.conflict) return { ok: false, reason: 'unresolved-conflict' }
    if (!candidate.temporalCurrent) return { ok: false, reason: 'temporal-mismatch' }
    return { ok: true }
  }

  #validateSource(candidate, evidence) {
    if (candidate.canonicalFacts.length > 0) return { ok: true, reason: 'canonical-fact-source-gate', checkedRefs: 0 }
    const refs = candidate.evidenceSourceRefs
    if (refs.length === 0) return { ok: false, reason: 'no-evidence-source-refs', checkedRefs: 0 }
    if (!this.sourceReader) return { ok: false, reason: 'source-unavailable', checkedRefs: 0 }
    let checkedRefs = 0
    let trustedRefs = 0
    for (const ref of refs) {
      if (candidate.raw.scopeKind === 'session' && String(ref.sessionId) !== String(candidate.raw.scopeId ?? candidate.raw.sessionId)) continue
      const source = this.sourceReader(ref)
      if (!source) continue
      checkedRefs += 1
      const role = String(source.role ?? '')
      const toolName = String(source.toolName ?? source.name ?? '')
      const trusted = role === 'user' || (role === 'tool' && this.config.trustedEvidenceTools.has(toolName))
      if (!trusted) continue
      trustedRefs += 1
      const text = normalize(sourceText(source))
      const verifiedMatches = evidence.matched.filter((item) => text.includes(normalize(item.value)) || text.includes(normalize(item.token)))
      const verified = scoreMatchedTerms(verifiedMatches)
      if (verified.score > 0) return { ok: true, reason: 'source-term-verified', checkedRefs, trustedRefs, matchedTerms: verifiedMatches.map((item) => item.value), verifiedScore: verified.score }
    }
    if (checkedRefs === 0) return { ok: false, reason: 'source-unavailable', checkedRefs }
    if (trustedRefs === 0) return { ok: false, reason: 'source-role-not-trusted', checkedRefs, trustedRefs }
    return { ok: false, reason: 'source-term-mismatch', checkedRefs, trustedRefs }
  }

  #candidateGeneration(query, records) {
    const queryTokens = lexicalTokens(query)
    const querySlots = new Set(this.hasher.slotKeys(this.hasher.hash(query)))
    const generated = []
    for (const candidate of records) {
      const names = [candidate.title, ...candidate.aliases]
      const facts = candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])
      const retrievalTerms = candidate.retrievalTerms.map((term) => term.value)
      const episode = candidate.raw.approvedEpisode === true ? [candidate.episodeSummary] : []
      const material = [...names, ...facts, ...retrievalTerms, ...episode].join(' ')
      const materialTokens = lexicalTokens(material)
      const exact = names.some((value) => exactBoundary(query, value))
      const tokenHit = [...queryTokens].some((token) => materialTokens.has(token) && !badToken(token, this.config.stopwords))
      const temporalHit = candidate.canonicalFacts.some((fact) => [fact.validFrom, fact.validTo].filter(Boolean).some((value) => normalize(query).includes(normalize(value))))
      const slots = new Set(this.hasher.slotKeys(this.hasher.hash(material)))
      const hashCandidate = [...querySlots].some((slot) => slots.has(slot))
      if (exact || tokenHit || temporalHit || hashCandidate) generated.push({ ...candidate, generatedBy: { exact, tokenHit, temporalHit, hashCandidate } })
      if (generated.length >= this.config.candidateLimit) break
    }
    return { queryTokens, generated }
  }

  #scoreCandidate(query, taskState, candidate) {
    const names = [candidate.title, ...candidate.aliases]
    const facts = candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])
    const generatedBy = {
      exact: names.some((value) => exactBoundary(query, value)),
      tokenHit: [...lexicalTokens(query)].some((token) => lexicalTokens([...names, ...facts, ...candidate.retrievalTerms.map((term) => term.value), candidate.episodeSummary].join(' ')).has(token) && !badToken(token, this.config.stopwords)),
      temporalHit: candidate.canonicalFacts.some((fact) => [fact.validFrom, fact.validTo].filter(Boolean).some((value) => normalize(query).includes(normalize(value)))),
      hashCandidate: candidate.generatedBy?.hashCandidate ?? false,
    }
    const eligibility = this.#eligible(candidate)
    if (!eligibility.ok) this.stats.hardRejected += 1
    const entityCoverage = coverage(lexicalTokens(query), names)
    const factCoverage = coverage(lexicalTokens(query), facts)
    const taskCoverage = coverage(lexicalTokens(JSON.stringify(taskState ?? {})), [...names, ...facts])
    const episodeCoverage = candidate.raw.approvedEpisode === true ? coverage(lexicalTokens(query), [candidate.episodeSummary]) : 0
    const temporalFit = candidate.temporalCurrent ? 1 : 0
    const baseRelevance = temporalFit * Math.max(generatedBy.exact ? 1 : 0,
      0.45 * entityCoverage + 0.35 * factCoverage + 0.15 * taskCoverage + 0.05 * episodeCoverage)
    const retrieval = retrievalEvidence(query, candidate.retrievalTerms, this.config.stopwords)
    const summaryOnly = candidate.canonicalFacts.length === 0
    const sourceValidation = summaryOnly && retrieval.score > 0
      ? this.#validateSource(candidate, retrieval)
      : { ok: !summaryOnly, reason: summaryOnly ? 'no-retrieval-anchor' : 'not-required', checkedRefs: 0 }
    if (summaryOnly && retrieval.score > 0 && !sourceValidation.ok) this.stats.sourceValidationRejected += 1
    const sourceEvidenceScore = sourceValidation.ok ? Number(sourceValidation.verifiedScore ?? retrieval.score) : 0
    const effectiveRelevance = Math.max(baseRelevance, sourceEvidenceScore)
    const sourceDirect = summaryOnly && sourceValidation.ok && sourceEvidenceScore >= 0.8
    const qualified = eligibility.ok && effectiveRelevance >= this.config.relevanceThreshold && (!summaryOnly || sourceDirect)
    return {
      ...candidate,
      generatedBy,
      exact: generatedBy.exact,
      baseRelevance,
      sourceEvidenceScore,
      effectiveRelevance,
      relevance: effectiveRelevance,
      scoreContributions: { entityCoverage, factCoverage, taskCoverage, episodeCoverage, temporalFit },
      matchedRetrievalTerms: retrieval.matched,
      sourceValidation,
      summaryOnly,
      sourceDirect,
      eligibility,
      qualified,
    }
  }

  #rank(query, taskState, records) {
    const { queryTokens, generated } = this.#candidateGeneration(query, records)
    void queryTokens
    return generated.map((candidate) => this.#scoreCandidate(query, taskState, candidate))
      .sort((left, right) => right.effectiveRelevance - left.effectiveRelevance || Number(right.exact) - Number(left.exact) || left.title.localeCompare(right.title))
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
      ranked = [...ranked, ...this.#rank(query, taskState, this.bankEntries(workspaceId, includeUserGlobal))]
        .sort((left, right) => right.relevance - left.relevance || left.title.localeCompare(right.title))
      qualified = ranked.filter((item) => item.qualified)
    }
    const bestRaw = ranked[0]
    const top = qualified[0]
    const second = qualified[1]
    const margin = top ? top.relevance - (second?.relevance ?? 0) : 0
    const duplicateExact = qualified.filter((item) => item.exact && normalize(item.title) === normalize(top?.title)).length > 1
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
    const reasons = []
    if (!top) reasons.push('no-qualified-candidate')
    if (top && margin < this.config.ambiguityMargin && !uniqueExactVerified) reasons.push('low-margin')
    if (duplicateExact) reasons.push('duplicate-exact-alias')
    if (coreference) reasons.push('coreference')
    if (temporalQuery) reasons.push('temporal-constraint')
    if (summaryWithoutAnswer) reasons.push('checkpoint-summary-without-answer')
    if (candidateConflict) reasons.push('conflict')
    if (bestRaw?.summaryOnly && bestRaw.sourceValidation?.ok === false && bestRaw.sourceValidation.reason !== 'no-retrieval-anchor') reasons.push(bestRaw.sourceValidation.reason)
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
      slowPathReasons: [...new Set(reasons)],
      searchedBank,
      generatedCandidateCount: ranked.length,
      eligibleCandidateCount: ranked.filter((item) => item.eligibility.ok).length,
      qualifiedCandidateCount: qualified.length,
      summaryOnlyCandidateCount: ranked.filter((item) => item.summaryOnly).length,
      sourceAnchoredCandidateCount: ranked.filter((item) => item.sourceEvidenceScore > 0).length,
      sourceValidationRejectedCount: ranked.filter((item) => item.summaryOnly && item.matchedRetrievalTerms.length > 0 && !item.sourceValidation.ok).length,
      bestRawCandidate: bestRaw ? { id: bestRaw.id, title: bestRaw.title, baseRelevance: bestRaw.baseRelevance, sourceEvidenceScore: bestRaw.sourceEvidenceScore, effectiveRelevance: bestRaw.effectiveRelevance, qualified: bestRaw.qualified, summaryOnly: bestRaw.summaryOnly, sourceValidation: bestRaw.sourceValidation, matchedRetrievalTerms: bestRaw.matchedRetrievalTerms } : null,
    }
    this.stats.generatedCandidates += result.generatedCandidateCount
    this.stats.qualifiedCandidates += result.qualifiedCandidateCount
    this.stats.sourceAnchoredCandidates += result.sourceAnchoredCandidateCount
    this.lastResult = result
    return result
  }

  verifySelected(result, selectedIds, planContext = {}) {
    const allowed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]))
    const resolvedQuery = [planContext.resolvedQuery, ...(planContext.entityHints ?? [])].map(String).map((value) => value.trim()).filter(Boolean).join(' ') || result.query
    this.stats.resolvedQueryRechecks += 1
    const selected = [...new Set(selectedIds ?? [])].map((id) => allowed.get(String(id))).filter(Boolean)
      .map((candidate) => this.#scoreCandidate(resolvedQuery, {}, candidate))
      .filter((candidate) => candidate.eligibility.ok && candidate.effectiveRelevance >= this.config.relevanceThreshold && (!candidate.summaryOnly || candidate.sourceDirect))
      .slice(0, this.config.catalogLimit)
    const margin = selected[0] ? selected[0].relevance - (selected[1]?.relevance ?? 0) : 0
    return { selected, verified: selected.length > 0 && (selected[0].exact || selected[0].sourceDirect || margin >= this.config.ambiguityMargin), margin, resolvedQuery }
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

  status() { return { ...this.stats, config: { ...this.config, stopwords: this.config.stopwords.size, trustedEvidenceTools: this.config.trustedEvidenceTools.size }, lastResult: this.lastResult ? { query: this.lastResult.query, topScore: this.lastResult.topScore, bestRawScore: this.lastResult.bestRawScore, bestQualifiedScore: this.lastResult.bestQualifiedScore, margin: this.lastResult.margin, sufficient: this.lastResult.sufficient, slowPathReasons: this.lastResult.slowPathReasons, generatedCandidateCount: this.lastResult.generatedCandidateCount, eligibleCandidateCount: this.lastResult.eligibleCandidateCount, qualifiedCandidateCount: this.lastResult.qualifiedCandidateCount, summaryOnlyCandidateCount: this.lastResult.summaryOnlyCandidateCount, sourceAnchoredCandidateCount: this.lastResult.sourceAnchoredCandidateCount, sourceValidationRejectedCount: this.lastResult.sourceValidationRejectedCount, bestRawCandidate: this.lastResult.bestRawCandidate } : null } }
}

export { SENSORY as SENSORY_LEDGER_COLLECTION }
