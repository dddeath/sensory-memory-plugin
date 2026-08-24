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
  return !text || POLLUTION.has(text) || stopwords.has(text) || /^[a-z]$/i.test(text)
}

export function informativeTokens(value, stopwords = DEFAULT_STOPWORDS) {
  return [...lexicalTokens(value)].filter((token) => !rejectedRetrievalToken(token, stopwords))
}

function tokenOverlap(left, right, stopwords) {
  const a = new Set(informativeTokens(left, stopwords))
  const b = new Set(informativeTokens(right, stopwords))
  if (a.size === 0 || b.size === 0) return 0
  const shared = [...a].filter((token) => b.has(token)).length
  return shared / Math.min(a.size, b.size)
}

export function decomposeRetrievalQuery(query, { stopwords = DEFAULT_STOPWORDS, maxSubqueries = 3 } = {}) {
  const globalQuery = String(query ?? '').trim()
  const raw = globalQuery
    .split(/(?:[。！？!?；;]\s*|，(?=(?:并且|以及|同时|然后|再|还|另|且))|\b(?:and|then|also)\b|(?:并且|以及|同时|然后|再问|还要))/iu)
    .map((value) => value.replace(/^[，、：:\s]+|[，、：:\s]+$/g, ''))
    .filter(Boolean)
  const accepted = []
  const rejectedClauses = []
  for (const clause of raw) {
    const tokens = informativeTokens(clause, stopwords)
    if (clause.length < 8 || tokens.length < 2) {
      rejectedClauses.push({ clause, reason: 'low-information' })
      continue
    }
    if ((raw.length === 1 && tokenOverlap(globalQuery, clause, stopwords) > 0.85)
      || accepted.some((current) => tokenOverlap(current, clause, stopwords) > 0.85)) {
      rejectedClauses.push({ clause, reason: 'duplicate' })
      continue
    }
    accepted.push(clause)
    if (accepted.length >= maxSubqueries) break
  }
  return {
    globalQuery,
    subqueries: accepted,
    rejectedClauses,
    allQueries: [globalQuery, ...accepted].filter(Boolean).map((text, index) => ({ id: `S${index}`, text, coverage: index > 0 })),
  }
}

function recordSourceRefs(record) { return record.sourceRefs ?? record.source_refs ?? [] }

export function renderCurrentParentView(parent) {
  const text = String(parent?.coreText ?? '')
  const ranges = (parent?.supersededRanges ?? [])
    .filter((range) => Number.isFinite(Number(range.startOffset)) && Number.isFinite(Number(range.endOffset)))
    .map((range) => ({ start: Math.max(0, Number(range.startOffset)), end: Math.min(text.length, Number(range.endOffset)) }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start)
  if (ranges.length === 0) return text
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  let cursor = 0
  const visible = []
  for (const range of merged) {
    if (range.start > cursor) visible.push(text.slice(cursor, range.start))
    cursor = range.end
  }
  if (cursor < text.length) visible.push(text.slice(cursor))
  return visible.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function compatibilityChild(record) {
  const text = String(record.contextText ?? record.coreText ?? record.text ?? record.episode ?? '')
  return [{
    childId: `${record.id}:child:001`, childIndex: 0, startOffset: 0,
    endOffset: String(record.coreText ?? text).length, tokenCount: 0,
    headingPath: record.headingPath ?? [], embeddingText: text,
    embeddingTextPreview: text.slice(0, 240), vector: record.vector ?? null,
    temporalCurrent: record.temporalCurrent !== false && !record.supersededBy,
    supersededBy: record.supersededBy ?? null, supersedes: [], compatibilityView: true,
  }]
}

export function toLayeredCandidate(record, layer) {
  const sourceRefs = recordSourceRefs(record)
  const coreText = renderCurrentParentView(record)
  return {
    id: String(record.id), parentId: String(record.id), chunkId: String(record.id),
    kind: 'context-parent', layer,
    label: String(record.label ?? record.documentTitle ?? record.headingPath?.join?.(' > ') ?? record.id),
    documentId: String(record.documentId ?? record.segmentId ?? record.id),
    documentTitle: String(record.documentTitle ?? record.label ?? ''),
    turn: Number(record.turn ?? 0), coreText, rawCoreText: String(record.coreText ?? ''),
    childSpans: (record.childSpans?.length ? record.childSpans : compatibilityChild(record))
      .filter((child) => child.temporalCurrent !== false && !child.supersededBy),
    vector: record.childSpans?.find((child) => child.temporalCurrent !== false && !child.supersededBy)?.vector ?? record.vector ?? null,
    sourceRefs, source_refs: sourceRefs,
    evidenceQuality: Number(record.evidenceQuality ?? (record.verifiedSource ? 0.9 : 0)),
    conflict: Boolean(record.conflict || record.unresolvedConflict),
    temporalCurrent: record.temporalCurrent !== false && !record.supersededBy,
    state: record.state ?? 'active', segmentId: String(record.segmentId ?? record.id), raw: record,
  }
}

export function candidateEligibility(candidate, { evidenceQualityThreshold }) {
  if (!candidate.coreText.trim()) return { ok: false, reason: 'empty-parent' }
  if (candidate.sourceRefs.length === 0) return { ok: false, reason: 'no-source-refs' }
  if (candidate.evidenceQuality < evidenceQualityThreshold) return { ok: false, reason: 'low-evidence-quality' }
  if (candidate.conflict) return { ok: false, reason: 'unresolved-conflict' }
  if (!candidate.temporalCurrent || candidate.childSpans.length === 0) return { ok: false, reason: 'temporal-mismatch' }
  if (candidate.state === 'pending-vector') return { ok: false, reason: 'pending-vector' }
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
  const normalizedCore = normalizeRetrievalText(candidate.rawCoreText || candidate.coreText)
  for (const ref of candidate.sourceRefs) {
    if (candidate.raw.scopeKind === 'session'
      && candidate.raw.referenceKind !== 'workspace-semipersistent'
      && String(ref.sessionId) !== String(candidate.raw.scopeId ?? candidate.raw.sessionId)) continue
    const source = sourceReader(ref)
    if (!source) continue
    checkedRefs += 1
    const text = normalizeRetrievalText(sourceText(source))
    if (text && (normalizedCore.includes(text.slice(0, Math.min(text.length, 80))) || text.includes(normalizedCore.slice(0, Math.min(normalizedCore.length, 80))))) matchedRefs += 1
  }
  if (checkedRefs === 0) return { ok: false, reason: 'source-unavailable', checkedRefs }
  if (matchedRefs === 0) return { ok: false, reason: 'source-chunk-mismatch', checkedRefs, matchedRefs }
  return { ok: true, reason: 'source-chunk-verified', checkedRefs, matchedRefs }
}

export function lexicalScore(query, text, stopwords = DEFAULT_STOPWORDS) {
  const queryText = normalizeRetrievalText(query)
  const candidateText = normalizeRetrievalText(text)
  const queryTokens = informativeTokens(query, stopwords)
  const candidateTokens = new Set(informativeTokens(text, stopwords))
  const matched = queryTokens.filter((token) => candidateTokens.has(token))
  const coverage = queryTokens.length ? matched.length / queryTokens.length : 0
  const strong = matched.filter((token) => (/^[\u3400-\u9fff]+$/u.test(token) ? token.length >= 2 : token.length >= 3 || /^\d{2,}$/.test(token)))
  const exactPhrase = queryText.length >= 3 && candidateText.includes(queryText)
  const score = exactPhrase ? 1 : coverage >= 0.75 ? 0.85 : strong.length >= 2 ? 0.80 : coverage >= 0.5 ? 0.70 : coverage >= 0.25 ? 0.35 : 0
  return { score, coverage, exactPhrase, matchedTokens: matched, strongMatchedTokens: strong, exactAnchor: exactPhrase || strong.length > 0 }
}

export function childText(parent, child) {
  const raw = parent.rawCoreText || parent.coreText
  const start = Math.max(0, Number(child.startOffset) || 0)
  const end = Math.max(start, Number(child.endOffset) || raw.length)
  return raw.slice(start, end) || String(child.embeddingText ?? child.embeddingTextPreview ?? '')
}

export function childVectorScore(queryVector, child) {
  if (!queryVector || !child?.vector) return 0
  if (queryVector.model !== child.vector.model || queryVector.dimensions !== child.vector.dimensions) return 0
  return Math.max(0, cosineSimilarity(queryVector.values, child.vector.values))
}

export function semanticRedundancy(left, right, stopwords = DEFAULT_STOPWORDS) {
  return tokenOverlap(left.coreText, right.coreText, stopwords)
}

export const exactRetrievalBoundary = (query, value) => normalizeRetrievalText(query).includes(normalizeRetrievalText(value))
export const validateCandidateSource = validateChunkSource
