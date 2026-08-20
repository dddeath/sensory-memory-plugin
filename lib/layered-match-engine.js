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

function candidateView(record, layer) {
  const facts = record.canonicalFacts ?? []
  const title = record.title ?? facts[0]?.subject ?? record.entity ?? record.name ?? record.id
  return {
    id: record.id,
    layer,
    title,
    name: title,
    aliases: record.aliases ?? [],
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
  constructor({ ledger, bank, config = {} }) {
    this.ledger = ledger
    this.bank = bank
    this.hasher = new NgramHashAddressing()
    this.config = {
      candidateLimit: Math.max(1, config.candidateLimit ?? 32),
      catalogLimit: Math.max(1, config.evidenceCatalogLimit ?? 3),
      relevanceThreshold: Number(config.relevanceThreshold ?? 0.70),
      evidenceQualityThreshold: Number(config.evidenceQualityThreshold ?? 0.80),
      ambiguityMargin: Number(config.ambiguityMargin ?? 0.15),
      stopwords: new Set([...DEFAULT_STOPWORDS, ...(config.memoryStopwords ?? []).map(normalize)]),
    }
    this.stats = { queries: 0, sensoryQueries: 0, bankQueries: 0, hardRejected: 0, slowPathRecommended: 0, zeroEvidence: 0 }
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

  #candidateGeneration(query, records) {
    const queryTokens = lexicalTokens(query)
    const querySlots = new Set(this.hasher.slotKeys(this.hasher.hash(query)))
    const generated = []
    for (const candidate of records) {
      const names = [candidate.title, ...candidate.aliases]
      const facts = candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])
      const episode = candidate.raw.approvedEpisode === true ? [candidate.episodeSummary] : []
      const material = [...names, ...facts, ...episode].join(' ')
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

  #rank(query, taskState, records) {
    const { queryTokens, generated } = this.#candidateGeneration(query, records)
    return generated.map((candidate) => {
      const eligibility = this.#eligible(candidate)
      if (!eligibility.ok) this.stats.hardRejected += 1
      const exact = candidate.generatedBy.exact
      const entityCoverage = coverage(queryTokens, [candidate.title, ...candidate.aliases])
      const factCoverage = coverage(queryTokens, candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value]))
      const taskCoverage = coverage(lexicalTokens(JSON.stringify(taskState ?? {})), [candidate.title, ...candidate.aliases, ...candidate.canonicalFacts.flatMap((fact) => [fact.subject, fact.predicate, fact.value])])
      const episodeCoverage = candidate.raw.approvedEpisode === true ? coverage(queryTokens, [candidate.episodeSummary]) : 0
      const temporalFit = candidate.temporalCurrent ? 1 : 0
      const relevance = temporalFit * Math.max(exact ? 1 : 0,
        0.45 * entityCoverage + 0.35 * factCoverage + 0.15 * taskCoverage + 0.05 * episodeCoverage)
      return { ...candidate, exact, relevance, eligibility, qualified: eligibility.ok && relevance >= this.config.relevanceThreshold }
    }).sort((left, right) => right.relevance - left.relevance || Number(right.exact) - Number(left.exact) || left.title.localeCompare(right.title))
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
    const top = qualified[0]
    const second = qualified[1]
    const margin = top ? top.relevance - (second?.relevance ?? 0) : 0
    const duplicateExact = qualified.filter((item) => item.exact && normalize(item.title) === normalize(top?.title)).length > 1
    const uniqueExactVerified = Boolean(top?.exact && !duplicateExact && top.canonicalFacts.length > 0)
    const coreference = /\b(?:it|that|this|previous|last)\b|(?:它|那个|上次|此前|之前)/iu.test(String(query))
    const temporalQuery = /(?:截至|现在|当前|当时|之前|之后|何时|什么时候|as\s+of|currently|before|after|when)/iu.test(String(query))
    const summaryWithoutAnswer = Boolean(top && top.canonicalFacts.length === 0)
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
      margin,
      sufficient,
      slowPathReasons: [...new Set(reasons)],
      searchedBank,
    }
    this.lastResult = result
    return result
  }

  verifySelected(result, selectedIds) {
    const allowed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]))
    const selected = [...new Set(selectedIds ?? [])].map((id) => allowed.get(String(id))).filter(Boolean)
      .filter((candidate) => candidate.eligibility.ok && candidate.relevance >= this.config.relevanceThreshold)
      .slice(0, this.config.catalogLimit)
    const margin = selected[0] ? selected[0].relevance - (selected[1]?.relevance ?? 0) : 0
    return { selected, verified: selected.length > 0 && (selected[0].exact || margin >= this.config.ambiguityMargin), margin }
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

  status() { return { ...this.stats, config: { ...this.config, stopwords: this.config.stopwords.size }, lastResult: this.lastResult ? { query: this.lastResult.query, topScore: this.lastResult.topScore, margin: this.lastResult.margin, sufficient: this.lastResult.sufficient, slowPathReasons: this.lastResult.slowPathReasons } : null } }
}

export { SENSORY as SENSORY_LEDGER_COLLECTION }
