const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'llm', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'user', 'was', 'were', 'with',
])

const POLLUTION = new Set(['in', 'to', 'on', 'a', 'user', 'llm'])

export function normalizeRetrievalText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function lexicalTokens(value) {
  const text = normalizeRetrievalText(value)
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

export function createStopwords(extra = []) {
  return new Set([...DEFAULT_STOPWORDS, ...extra.map(normalizeRetrievalText)])
}

export function rejectedRetrievalToken(value, stopwords = DEFAULT_STOPWORDS) {
  const text = normalizeRetrievalText(value)
  if (!text || POLLUTION.has(text) || stopwords.has(text)) return true
  if (/^[a-z]$/i.test(text)) return true
  if (/^(?:https?:\/\/|[a-z]:\\|\/[^\s]+|\.\.?\/)/iu.test(text)) return true
  return /[{}<>]=>|\b(?:const|let|var|function|npm|node|scm=)\b/iu.test(text)
}

export function exactRetrievalBoundary(query, value) {
  const normalizedQuery = normalizeRetrievalText(query)
  const needle = normalizeRetrievalText(value)
  if (!needle) return false
  if (/^[a-z0-9_-]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i').test(normalizedQuery)
  }
  return normalizedQuery.includes(needle)
}

function coverage(queryTokens, values) {
  const material = new Set(values.flatMap((value) => [...lexicalTokens(value)]))
  const informative = [...queryTokens].filter((token) => !DEFAULT_STOPWORDS.has(token) && !rejectedRetrievalToken(token, DEFAULT_STOPWORDS))
  if (informative.length === 0) return 0
  return informative.filter((token) => material.has(token)).length / informative.length
}

function recordSourceRefs(record) {
  return record.sourceRefs ?? record.source_refs ?? []
}

function recordEvidenceSourceRefs(record) {
  return record.evidenceSourceRefs ?? record.evidence_source_refs ?? []
}

function sourceText(value) {
  if (typeof value === 'string') return value
  return String(value?.text ?? value?.content ?? '')
}

function strongestSharedToken(queryTokens, value, stopwords) {
  const material = lexicalTokens(value)
  return [...queryTokens]
    .filter((token) => material.has(token) && !rejectedRetrievalToken(token, stopwords))
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
    if (!value || rejectedRetrievalToken(value, stopwords)) continue
    const full = exactRetrievalBoundary(query, value)
    const token = full ? value : strongestSharedToken(queryTokens, value, stopwords)
    if (!full && !token) continue
    matched.push({ value, kind: term.kind ?? 'term', sourceRefs: term.sourceRefs ?? [], matchType: full ? 'full' : 'partial', token })
  }
  return scoreMatchedTerms(matched)
}

export function toLayeredCandidate(record, layer) {
  const facts = record.canonicalFacts ?? []
  const title = record.title ?? facts[0]?.subject ?? record.entity ?? record.name ?? record.id
  const refs = recordSourceRefs(record)
  return {
    id: record.id,
    layer,
    title,
    name: title,
    aliases: record.aliases ?? [],
    retrievalTerms: record.retrievalTerms ?? [],
    evidenceSourceRefs: recordEvidenceSourceRefs(record),
    canonicalFacts: facts,
    episodeSummary: record.episodeSummary ?? record.episode ?? '',
    sourceRefs: refs,
    source_refs: refs,
    evidenceQuality: Number(record.evidenceQuality ?? (record.verifiedSource ? 0.9 : 0)),
    conflict: Boolean(record.conflict || record.unresolvedConflict),
    temporalCurrent: record.temporalCurrent !== false && !facts.some((fact) => fact.current === false && fact.validTo === null),
    raw: record,
  }
}

export function candidateEligibility(candidate, { stopwords, evidenceQualityThreshold }) {
  if (rejectedRetrievalToken(candidate.title, stopwords)) return { ok: false, reason: 'generic-or-code-title' }
  if (candidate.raw.qualityFlags?.includes?.('QUESTION_WITHOUT_ANSWER')) return { ok: false, reason: 'question-without-answer' }
  if (candidate.sourceRefs.length === 0) return { ok: false, reason: 'no-source-refs' }
  if (candidate.evidenceQuality < evidenceQualityThreshold) return { ok: false, reason: 'low-evidence-quality' }
  if (candidate.conflict) return { ok: false, reason: 'unresolved-conflict' }
  if (!candidate.temporalCurrent) return { ok: false, reason: 'temporal-mismatch' }
  return { ok: true }
}

export function validateCandidateSource(candidate, evidence, { sourceReader, trustedEvidenceTools }) {
  if (candidate.canonicalFacts.length > 0) return { ok: true, reason: 'canonical-fact-source-gate', checkedRefs: 0 }
  const refs = candidate.evidenceSourceRefs
  if (refs.length === 0) return { ok: false, reason: 'no-evidence-source-refs', checkedRefs: 0 }
  if (!sourceReader) return { ok: false, reason: 'source-unavailable', checkedRefs: 0 }
  let checkedRefs = 0
  let trustedRefs = 0
  for (const ref of refs) {
    if (candidate.raw.scopeKind === 'session' && String(ref.sessionId) !== String(candidate.raw.scopeId ?? candidate.raw.sessionId)) continue
    const source = sourceReader(ref)
    if (!source) continue
    checkedRefs += 1
    const role = String(source.role ?? '')
    const toolName = String(source.toolName ?? source.name ?? '')
    if (role !== 'user' && !(role === 'tool' && trustedEvidenceTools.has(toolName))) continue
    trustedRefs += 1
    const text = normalizeRetrievalText(sourceText(source))
    const verifiedMatches = evidence.matched.filter((item) => text.includes(normalizeRetrievalText(item.value)) || text.includes(normalizeRetrievalText(item.token)))
    const verified = scoreMatchedTerms(verifiedMatches)
    if (verified.score > 0) {
      return {
        ok: true,
        reason: 'source-term-verified',
        checkedRefs,
        trustedRefs,
        matchedTerms: verifiedMatches.map((item) => item.value),
        verifiedScore: verified.score,
      }
    }
  }
  if (checkedRefs === 0) return { ok: false, reason: 'source-unavailable', checkedRefs }
  if (trustedRefs === 0) return { ok: false, reason: 'source-role-not-trusted', checkedRefs, trustedRefs }
  return { ok: false, reason: 'source-term-mismatch', checkedRefs, trustedRefs }
}

export function generateCandidates(query, records, { hasher, candidateLimit, stopwords }) {
  const queryTokens = lexicalTokens(query)
  const querySlots = new Set(hasher.slotKeys(hasher.hash(query)))
  const generated = []
  for (const candidate of records) {
    const names = [candidate.title, ...candidate.aliases]
    const facts = candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])
    const retrievalTerms = candidate.retrievalTerms.map((term) => term.value)
    const episode = candidate.raw.approvedEpisode === true ? [candidate.episodeSummary] : []
    const material = [...names, ...facts, ...retrievalTerms, ...episode].join(' ')
    const materialTokens = lexicalTokens(material)
    const exact = names.some((value) => exactRetrievalBoundary(query, value))
    const tokenHit = [...queryTokens].some((token) => materialTokens.has(token) && !rejectedRetrievalToken(token, stopwords))
    const temporalHit = candidate.canonicalFacts.some((fact) => [fact.validFrom, fact.validTo].filter(Boolean).some((value) => normalizeRetrievalText(query).includes(normalizeRetrievalText(value))))
    const slots = new Set(hasher.slotKeys(hasher.hash(material)))
    const hashCandidate = [...querySlots].some((slot) => slots.has(slot))
    if (exact || tokenHit || temporalHit || hashCandidate) generated.push({ ...candidate, generatedBy: { exact, tokenHit, temporalHit, hashCandidate } })
    if (generated.length >= candidateLimit) break
  }
  return generated
}

export function scoreCandidate(query, taskState, candidate, config, sourceReader) {
  const queryTokens = lexicalTokens(query)
  const names = [candidate.title, ...candidate.aliases]
  const facts = candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])
  const candidateMaterial = [...names, ...facts, ...candidate.retrievalTerms.map((term) => term.value), candidate.episodeSummary].join(' ')
  const materialTokens = lexicalTokens(candidateMaterial)
  const generatedBy = {
    exact: names.some((value) => exactRetrievalBoundary(query, value)),
    tokenHit: [...queryTokens].some((token) => materialTokens.has(token) && !rejectedRetrievalToken(token, config.stopwords)),
    temporalHit: candidate.canonicalFacts.some((fact) => [fact.validFrom, fact.validTo].filter(Boolean).some((value) => normalizeRetrievalText(query).includes(normalizeRetrievalText(value)))),
    hashCandidate: candidate.generatedBy?.hashCandidate ?? false,
  }
  const eligibility = candidateEligibility(candidate, config)
  const entityCoverage = coverage(queryTokens, names)
  const factCoverage = coverage(queryTokens, facts)
  const taskCoverage = coverage(lexicalTokens(JSON.stringify(taskState ?? {})), [...names, ...facts])
  const episodeCoverage = candidate.raw.approvedEpisode === true ? coverage(queryTokens, [candidate.episodeSummary]) : 0
  const temporalFit = candidate.temporalCurrent ? 1 : 0
  const baseRelevance = temporalFit * Math.max(generatedBy.exact ? 1 : 0,
    0.45 * entityCoverage + 0.35 * factCoverage + 0.15 * taskCoverage + 0.05 * episodeCoverage)
  const retrieval = retrievalEvidence(query, candidate.retrievalTerms, config.stopwords)
  const summaryOnly = candidate.canonicalFacts.length === 0
  const sourceValidation = summaryOnly && retrieval.score > 0
    ? validateCandidateSource(candidate, retrieval, { sourceReader, trustedEvidenceTools: config.trustedEvidenceTools })
    : { ok: !summaryOnly, reason: summaryOnly ? 'no-retrieval-anchor' : 'not-required', checkedRefs: 0 }
  const sourceEvidenceScore = sourceValidation.ok ? Number(sourceValidation.verifiedScore ?? retrieval.score) : 0
  const effectiveRelevance = Math.max(baseRelevance, sourceEvidenceScore)
  const sourceDirect = summaryOnly && sourceValidation.ok && sourceEvidenceScore >= 0.8
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
    qualified: eligibility.ok && effectiveRelevance >= config.relevanceThreshold && (!summaryOnly || sourceDirect),
  }
}
