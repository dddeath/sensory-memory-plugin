import { cosineSimilarity } from './vector-encoder.js'

const DEFAULT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'llm', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'user', 'was', 'were', 'with',
])

const POLLUTION = new Set(['in', 'to', 'on', 'a', 'user', 'llm'])

export function normalizeRetrievalText(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function lexicalTokens(value) {
  const text = normalizeRetrievalText(value)
  const result = new Set()
  for (const match of text.matchAll(/[a-z][\w-]*|\d+(?:\.\d+)?/g)) result.add(match[0])
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
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
  return false
}

function informativeTokens(value, stopwords) {
  return [...lexicalTokens(value)].filter((token) => !rejectedRetrievalToken(token, stopwords))
}

function recordSourceRefs(record) {
  return record.sourceRefs ?? record.source_refs ?? []
}

export function toLayeredCandidate(record, layer) {
  const sourceRefs = recordSourceRefs(record)
  const coreText = String(record.coreText ?? record.text ?? record.episode ?? '')
  const contextText = String(record.contextText ?? coreText)
  return {
    id: String(record.id),
    chunkId: String(record.id),
    kind: 'context-chunk',
    layer,
    label: String(record.label ?? record.headingPath?.join?.(' > ') ?? record.id),
    coreText,
    contextText,
    vector: record.vector ?? null,
    sourceRefs,
    source_refs: sourceRefs,
    evidenceQuality: Number(record.evidenceQuality ?? (record.verifiedSource ? 0.9 : 0)),
    conflict: Boolean(record.conflict || record.unresolvedConflict),
    temporalCurrent: record.temporalCurrent !== false && !record.supersededBy,
    segmentId: String(record.segmentId ?? record.id),
    raw: record,
  }
}

export function candidateEligibility(candidate, { evidenceQualityThreshold }) {
  if (!candidate.coreText.trim()) return { ok: false, reason: 'empty-chunk' }
  if (candidate.sourceRefs.length === 0) return { ok: false, reason: 'no-source-refs' }
  if (candidate.evidenceQuality < evidenceQualityThreshold) return { ok: false, reason: 'low-evidence-quality' }
  if (candidate.conflict) return { ok: false, reason: 'unresolved-conflict' }
  if (!candidate.temporalCurrent) return { ok: false, reason: 'temporal-mismatch' }
  return { ok: true }
}

function sourceText(value) {
  if (typeof value === 'string') return value
  return String(value?.text ?? value?.content ?? '')
}

export function validateChunkSource(candidate, sourceReader) {
  if (candidate.sourceRefs.length === 0) return { ok: false, reason: 'no-source-refs', checkedRefs: 0 }
  if (!sourceReader) return { ok: Boolean(candidate.raw.verifiedSource), reason: candidate.raw.verifiedSource ? 'ledger-source-verified' : 'source-unavailable', checkedRefs: 0 }
  let checkedRefs = 0
  let matchedRefs = 0
  const normalizedCore = normalizeRetrievalText(candidate.coreText)
  for (const ref of candidate.sourceRefs) {
    if (candidate.raw.scopeKind === 'session' && String(ref.sessionId) !== String(candidate.raw.scopeId ?? candidate.raw.sessionId)) continue
    const source = sourceReader(ref)
    if (!source) continue
    checkedRefs += 1
    const text = normalizeRetrievalText(sourceText(source))
    if (text && (normalizedCore.includes(text.slice(0, Math.min(text.length, 80))) || text.includes(normalizedCore.slice(0, Math.min(normalizedCore.length, 80))))) {
      matchedRefs += 1
    }
  }
  if (checkedRefs === 0) return { ok: false, reason: 'source-unavailable', checkedRefs }
  if (matchedRefs === 0) return { ok: false, reason: 'source-chunk-mismatch', checkedRefs, matchedRefs }
  return { ok: true, reason: 'source-chunk-verified', checkedRefs, matchedRefs }
}

function lexicalScore(query, candidate, stopwords) {
  const queryText = normalizeRetrievalText(query)
  const coreText = normalizeRetrievalText(candidate.coreText)
  const queryTokens = informativeTokens(query, stopwords)
  const coreTokens = new Set(informativeTokens(candidate.coreText, stopwords))
  const matched = queryTokens.filter((token) => coreTokens.has(token))
  const coverage = queryTokens.length ? matched.length / queryTokens.length : 0
  const strongMatched = matched.filter((token) => (/^[\u3400-\u9fff]+$/u.test(token) ? token.length >= 2 : token.length >= 3 || /^\d{2,}$/.test(token)))
  const exactPhrase = queryText.length >= 3 && coreText.includes(queryText)
  const score = exactPhrase ? 1
    : coverage >= 0.75 ? 0.85
      : strongMatched.length >= 2 ? 0.80
      : coverage >= 0.5 ? 0.70
        : coverage >= 0.25 ? 0.35
          : 0
  return { score, coverage, exactPhrase, matchedTokens: matched, strongMatchedTokens: strongMatched }
}

function vectorScore(queryVector, candidate) {
  if (!queryVector || !candidate.vector) return 0
  if (queryVector.model !== candidate.vector.model || queryVector.dimensions !== candidate.vector.dimensions) return 0
  return Math.max(0, cosineSimilarity(queryVector.values, candidate.vector.values))
}

export function scoreCandidate(query, candidate, config, sourceReader, queryVector = null) {
  const lexical = lexicalScore(query, candidate, config.stopwords)
  const semantic = vectorScore(queryVector, candidate)
  const sourceValidation = validateChunkSource(candidate, sourceReader)
  const eligibility = candidateEligibility(candidate, config)
  const effectiveRelevance = Math.max(lexical.score, semantic)
  return {
    ...candidate,
    lexicalRelevance: lexical.score,
    vectorRelevance: semantic,
    effectiveRelevance,
    relevance: effectiveRelevance,
    matchedTokens: lexical.matchedTokens,
    scoreContributions: { lexicalCoverage: lexical.coverage, exactPhrase: lexical.exactPhrase, vectorSimilarity: semantic },
    sourceValidation,
    eligibility,
    qualified: eligibility.ok && sourceValidation.ok && effectiveRelevance >= config.relevanceThreshold,
  }
}

export function generateCandidates(query, records, { candidateLimit, stopwords, queryVector = null, vectorCandidateThreshold = 0.18 }) {
  const generated = records.map((candidate) => {
    const lexical = lexicalScore(query, candidate, stopwords)
    const semantic = vectorScore(queryVector, candidate)
    return { candidate, lexical, semantic }
  }).filter((item) => item.lexical.score > 0 || item.semantic >= vectorCandidateThreshold)
    .sort((left, right) => Math.max(right.lexical.score, right.semantic) - Math.max(left.lexical.score, left.semantic)
      || Number(right.candidate.raw.updatedAt ?? 0) - Number(left.candidate.raw.updatedAt ?? 0))
    .slice(0, candidateLimit)
    .map((item) => ({
      ...item.candidate,
      generatedBy: {
        lexical: item.lexical.score > 0,
        vector: item.semantic >= vectorCandidateThreshold,
      },
    }))
  return generated
}

export const exactRetrievalBoundary = (query, value) => normalizeRetrievalText(query).includes(normalizeRetrievalText(value))
export const validateCandidateSource = validateChunkSource
