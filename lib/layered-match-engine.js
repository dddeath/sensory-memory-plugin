import { estimateTokens } from './context-utils.js'
import {
  candidateEligibility,
  childText,
  childVectorScore,
  createStopwords,
  decomposeRetrievalQuery,
  lexicalScore,
  lexicalTokens,
  semanticRedundancy,
  toLayeredCandidate,
  validateChunkSource,
} from './layered-match-support.js'

const SENSORY = 'sensoryChunks'

function parentRanking(left, right) {
  return Number(right.coveredSubqueries?.length ?? 0) - Number(left.coveredSubqueries?.length ?? 0)
    || right.bestDenseScore - left.bestDenseScore
    || right.exactAnchors - left.exactAnchors
    || right.effectiveRelevance - left.effectiveRelevance
    || Number(right.raw.updatedAt ?? 0) - Number(left.raw.updatedAt ?? 0)
    || left.id.localeCompare(right.id)
}

function lastResultStatus(result) {
  if (!result) return null
  return {
    query: result.query,
    querySubqueries: result.queryPlan?.subqueries ?? [],
    topScore: result.topScore,
    bestRawScore: result.bestRawScore,
    sufficient: result.sufficient,
    needsPlanner: result.needsPlanner,
    slowPathReasons: result.slowPathReasons,
    generatedChildCount: result.generatedChildCount,
    eligibleParentCount: result.eligibleParentCount,
    selectedParentCount: result.selectedParentCount,
    coveredSubqueries: result.coveredSubqueries,
    uncoveredSubqueries: result.uncoveredSubqueries,
    recallGuardCount: result.recallGuardCount,
    redundancyRejectedCount: result.redundancyRejectedCount,
    bestRawCandidate: result.bestRawCandidate,
  }
}

function unique(values) { return [...new Set(values)] }

function clipWholeParents(selected, budgetTokens) {
  if (!Number.isFinite(budgetTokens)) return selected
  const accepted = []
  let used = 0
  for (const parent of selected) {
    const cost = estimateTokens(parent.coreText) + 24
    if (used + cost > budgetTokens) continue
    accepted.push(parent)
    used += cost
  }
  return accepted
}

export class LayeredMatchEngine {
  constructor({ ledger, bank, vectorEncoder = null, sourceReader = null, config = {} }) {
    this.ledger = ledger
    this.bank = bank
    this.vectorEncoder = vectorEncoder
    this.sourceReader = typeof sourceReader === 'function' ? sourceReader : null
    this.config = {
      childTopK: Math.max(1, config.childTopK ?? 8),
      childUnionLimit: Math.max(1, config.childUnionLimit ?? 32),
      parentEligibleLimit: Math.max(1, config.parentEligibleLimit ?? 16),
      parentSelectLimit: Math.max(1, config.parentSelectLimit ?? config.evidenceCatalogLimit ?? 6),
      relativeScoreWindow: Math.max(0, Number(config.relativeScoreWindow ?? 0.12)),
      evidenceQualityThreshold: Number(config.evidenceQualityThreshold ?? 0.80),
      ambiguityMargin: Number(config.ambiguityMargin ?? 0.15),
      vectorCandidateThreshold: Number(config.vectorCandidateThreshold ?? 0.18),
      vectorLowConfidenceFloor: Number(config.vectorLowConfidenceFloor ?? 0.50),
      stopwords: createStopwords(config.memoryStopwords ?? []),
    }
    this.stats = {
      queries: 0, sensoryQueries: 0, bankQueries: 0, hardRejected: 0,
      slowPathRecommended: 0, plannerSkippedNoCandidates: 0,
      plannerSkippedWeakCandidates: 0, zeroEvidence: 0,
      generatedChildren: 0, eligibleParents: 0, selectedParents: 0,
      vectorCandidates: 0, sourceValidationRejected: 0,
      recallGuards: 0, redundancyRejected: 0, resolvedQueryRechecks: 0,
    }
    this.lastResult = null
  }

  sensoryChunks(sessionId) {
    return this.ledger.list(SENSORY, { scopeKind: 'session', scopeId: sessionId })
      .filter((record) => !record.tombstonedAt && record.temporalCurrent !== false && !record.supersededBy)
      .map((record) => toLayeredCandidate(record, 'sensory'))
  }

  bankChunks(workspaceId, includeUserGlobal = true) {
    return this.bank.listVisible({ workspaceId, includeUserGlobal }).map((record) => toLayeredCandidate(record, 'bank'))
  }

  #parentMeta(records) {
    return new Map(records.map((parent) => {
      const eligibility = candidateEligibility(parent, this.config)
      const sourceValidation = validateChunkSource(parent, this.sourceReader)
      if (!eligibility.ok) this.stats.hardRejected += 1
      if (!sourceValidation.ok) this.stats.sourceValidationRejected += 1
      return [parent.id, { parent, eligibility, sourceValidation }]
    }))
  }

  #recallChildren(queryPlan, records, queryVectors) {
    const parentMeta = this.#parentMeta(records)
    const union = new Map()
    let recallGuardCount = 0
    for (let queryIndex = 0; queryIndex < queryPlan.allQueries.length; queryIndex += 1) {
      const query = queryPlan.allQueries[queryIndex]
      const queryVector = queryVectors[queryIndex] ?? null
      const rows = []
      for (const { parent } of parentMeta.values()) {
        for (const child of parent.childSpans) {
          const text = childText(parent, child)
          const lexical = lexicalScore(query.text, [parent.documentTitle, ...(child.headingPath ?? []), text].filter(Boolean).join('\n'), this.config.stopwords)
          const dense = childVectorScore(queryVector, child)
          const score = Math.max(lexical.score, dense)
          if (score <= 0) continue
          rows.push({ parent, child, query, lexical, dense, score })
        }
      }
      rows.sort((left, right) => right.score - left.score || right.dense - left.dense || left.child.childId.localeCompare(right.child.childId))
      const topScore = rows[0]?.score ?? 0
      const admitted = []
      for (let index = 0; index < rows.length && admitted.length < this.config.childTopK; index += 1) {
        const row = rows[index]
        const meta = parentMeta.get(row.parent.id)
        const reasons = []
        if (row.lexical.exactAnchor) reasons.push('lexical-anchor')
        if (row.score >= Math.max(0, topScore - this.config.relativeScoreWindow)) reasons.push('relative-window')
        if (index === 0 && meta?.eligibility.ok && meta?.sourceValidation.ok) {
          reasons.push('top1-recall-guard')
          recallGuardCount += 1
        }
        if (reasons.length === 0) continue
        admitted.push({
          ...row,
          admissionReasons: reasons,
          coverageEligible: index === 0 || row.lexical.exactPhrase || row.lexical.coverage >= 0.50,
        })
      }
      for (const hit of admitted) {
        const key = `${hit.parent.id}\u0000${hit.child.childId}`
        const previous = union.get(key) ?? { parent: hit.parent, child: hit.child, byQuery: new Map(), admissionReasons: new Set() }
        previous.byQuery.set(hit.query.id, hit)
        hit.admissionReasons.forEach((reason) => previous.admissionReasons.add(reason))
        union.set(key, previous)
      }
    }
    const childHits = [...union.values()]
      .sort((left, right) => Math.max(...[...right.byQuery.values()].map((hit) => hit.score)) - Math.max(...[...left.byQuery.values()].map((hit) => hit.score)))
      .slice(0, this.config.childUnionLimit)
    return { parentMeta, childHits, recallGuardCount }
  }

  #aggregateParents(queryPlan, recall) {
    const grouped = new Map()
    for (const childHit of recall.childHits) {
      const current = grouped.get(childHit.parent.id) ?? { parent: childHit.parent, childHits: [] }
      current.childHits.push(childHit)
      grouped.set(childHit.parent.id, current)
    }
    return [...grouped.values()].map(({ parent, childHits }) => {
      const hits = childHits.flatMap((childHit) => [...childHit.byQuery.values()])
      const dense = hits.map((hit) => hit.dense).sort((a, b) => b - a)
      const lexical = hits.map((hit) => hit.lexical.score)
      const matchedSubqueries = unique(hits.filter((hit) => hit.coverageEligible).map((hit) => hit.query.id))
      const exactAnchors = hits.filter((hit) => hit.lexical.exactAnchor).length
      const admissionReasons = unique(childHits.flatMap((hit) => [...hit.admissionReasons]))
      const onlyGuard = admissionReasons.length === 1 && admissionReasons[0] === 'top1-recall-guard'
      const bestDenseScore = dense[0] ?? 0
      const lowConfidence = exactAnchors === 0 && onlyGuard && bestDenseScore < this.config.vectorLowConfidenceFloor
      const meta = recall.parentMeta.get(parent.id)
      const effectiveRelevance = Math.max(bestDenseScore, ...lexical, 0)
      return {
        ...parent,
        childHits: childHits.map((item) => ({
          childId: item.child.childId,
          startOffset: item.child.startOffset,
          endOffset: item.child.endOffset,
          matchedQueries: [...item.byQuery.keys()],
          scores: Object.fromEntries([...item.byQuery].map(([id, hit]) => [id, { dense: hit.dense, lexical: hit.lexical.score }])),
          admissionReasons: [...item.admissionReasons],
        })),
        matchedSubqueries,
        coveredSubqueries: matchedSubqueries.filter((id) => id !== 'S0'),
        bestDenseScore,
        averageTopChildScore: dense.length ? dense.slice(0, 2).reduce((sum, value) => sum + value, 0) / Math.min(2, dense.length) : 0,
        exactAnchors,
        admissionReasons,
        lowConfidence,
        effectiveRelevance,
        relevance: effectiveRelevance,
        lexicalRelevance: Math.max(...lexical, 0),
        vectorRelevance: bestDenseScore,
        matchedTokens: unique(hits.flatMap((hit) => hit.lexical.matchedTokens)),
        sourceValidation: meta.sourceValidation,
        eligibility: meta.eligibility,
        qualified: meta.eligibility.ok && meta.sourceValidation.ok && !lowConfidence,
        scoreContributions: {
          bestDenseScore,
          averageTopChildScore: dense.length ? dense.slice(0, 2).reduce((sum, value) => sum + value, 0) / Math.min(2, dense.length) : 0,
          exactAnchors,
          matchedSubqueries,
        },
        generatedBy: { vector: dense.some((score) => score > 0), lexical: lexical.some((score) => score > 0) },
      }
    }).sort(parentRanking)
  }

  #selectCoverage(queryPlan, parents) {
    const targets = queryPlan.subqueries.map((_, index) => `S${index + 1}`)
    const globalOnly = targets.length === 0
    const remaining = parents.filter((parent) => parent.qualified)
    const selected = []
    const covered = new Set()
    const sourceTurns = new Set()
    let redundancyRejectedCount = 0
    while (selected.length < this.config.parentSelectLimit && remaining.length > 0 && (globalOnly || covered.size < targets.length)) {
      let best = null
      for (const parent of remaining) {
        const newCoverage = targets.filter((id) => parent.matchedSubqueries.includes(id) && !covered.has(id))
        if (!globalOnly && newCoverage.length === 0) continue
        const sourceKey = `${parent.documentId}:${parent.turn}`
        const redundancy = selected.length ? Math.max(...selected.map((item) => semanticRedundancy(parent, item, this.config.stopwords))) : 0
        const value = (globalOnly ? (selected.length === 0 ? 1 : 0) : newCoverage.length * 2)
          + parent.bestDenseScore
          + Math.min(0.45, parent.exactAnchors * 0.15)
          + (sourceTurns.has(sourceKey) ? 0 : 0.15)
          - redundancy * 0.40
        if (!best || value > best.value || (value === best.value && parentRanking(parent, best.parent) < 0)) best = { parent, value, newCoverage, redundancy, sourceKey }
      }
      if (!best || best.value <= 0) break
      selected.push({ ...best.parent, coverageDecision: { value: best.value, newCoverage: best.newCoverage, redundancy: best.redundancy } })
      best.newCoverage.forEach((id) => covered.add(id))
      sourceTurns.add(best.sourceKey)
      remaining.splice(remaining.findIndex((item) => item.id === best.parent.id), 1)
      redundancyRejectedCount += remaining.filter((item) => selected.some((chosen) => semanticRedundancy(item, chosen, this.config.stopwords) > 0.85)).length
    }
    return {
      selected,
      coveredSubqueries: globalOnly && selected.length ? ['S0'] : [...covered],
      uncoveredSubqueries: targets.filter((id) => !covered.has(id)),
      redundancyRejectedCount,
    }
  }

  #rankRecords(queryPlan, records, queryVectors) {
    const recall = this.#recallChildren(queryPlan, records, queryVectors)
    const parents = this.#aggregateParents(queryPlan, recall).slice(0, this.config.parentEligibleLimit)
    const coverage = this.#selectCoverage(queryPlan, parents)
    return { ...coverage, parents, recall }
  }

  #result(query, viewer, queryPlan, ranked, searchedBank) {
    const qualified = ranked.parents.filter((parent) => parent.qualified)
    const top = qualified[0] ?? null
    const second = qualified[1] ?? null
    const margin = top ? top.effectiveRelevance - (second?.effectiveRelevance ?? 0) : 0
    const coreference = /^\s*(?:it|that|this)\b|\b(?:that one|this one|the previous one|the last one)\b|(?:上次那个|此前那个|之前那个|^\s*它\b|^\s*那个)/iu.test(String(query))
    const temporalQuery = /(?:截至|现在|当前|当时|何时|什么时候|as\s+of|currently|before\s+(?:that|then|\d)|after\s+(?:that|then|\d))/iu.test(String(query))
    const conflicts = ranked.parents.some((parent) => parent.conflict)
    const lowConfidence = ranked.parents.some((parent) => parent.lowConfidence)
    const sufficient = ranked.selected.length > 0 && ranked.uncoveredSubqueries.length === 0 && !coreference && !conflicts
    const slowPathReasons = []
    if (coreference && ranked.parents.length) slowPathReasons.push('coreference')
    if (temporalQuery && ranked.parents.length > 1) slowPathReasons.push('temporal-ambiguity')
    if (ranked.uncoveredSubqueries.length && ranked.parents.length) slowPathReasons.push('uncovered-subqueries')
    if (conflicts) slowPathReasons.push('conflict')
    const anchoredOrStructured = ranked.parents.some((parent) => parent.exactAnchors > 0) || queryPlan.subqueries.length > 1
    if (!qualified.length && lowConfidence && anchoredOrStructured) slowPathReasons.push('low-confidence-recall')
    const needsPlanner = !sufficient && ranked.parents.length > 0 && slowPathReasons.length > 0
    if (needsPlanner) this.stats.slowPathRecommended += 1
    if (ranked.parents.length === 0) this.stats.plannerSkippedNoCandidates += 1
    if (!sufficient && ranked.parents.length && !needsPlanner) this.stats.plannerSkippedWeakCandidates += 1
    if (ranked.selected.length === 0) this.stats.zeroEvidence += 1
    const bestRaw = ranked.parents[0] ?? null
    const result = {
      query: String(query), sessionId: String(viewer.sessionId), workspaceId: String(viewer.workspaceId), queryPlan,
      candidates: ranked.parents, qualified, selected: sufficient ? ranked.selected : [],
      topScore: top?.effectiveRelevance ?? 0, bestRawScore: bestRaw?.effectiveRelevance ?? 0, margin,
      sufficient, needsPlanner, slowPathReasons, searchedBank,
      generatedChildCount: ranked.recall.childHits.length,
      generatedCandidateCount: ranked.recall.childHits.length,
      eligibleParentCount: ranked.parents.length,
      qualifiedCandidateCount: qualified.length,
      selectedParentCount: sufficient ? ranked.selected.length : 0,
      vectorCandidateCount: ranked.parents.filter((parent) => parent.generatedBy.vector).length,
      coveredSubqueries: sufficient ? ranked.coveredSubqueries : [],
      uncoveredSubqueries: ranked.uncoveredSubqueries,
      recallGuardCount: ranked.recall.recallGuardCount,
      redundancyRejectedCount: ranked.redundancyRejectedCount,
      bestRawCandidate: bestRaw ? {
        id: bestRaw.id, label: bestRaw.label, bestDenseScore: bestRaw.bestDenseScore,
        lexicalRelevance: bestRaw.lexicalRelevance, effectiveRelevance: bestRaw.effectiveRelevance,
        exactAnchors: bestRaw.exactAnchors, lowConfidence: bestRaw.lowConfidence,
        sourceValidation: bestRaw.sourceValidation,
      } : null,
    }
    this.stats.generatedChildren += result.generatedChildCount
    this.stats.eligibleParents += result.eligibleParentCount
    this.stats.selectedParents += result.selectedParentCount
    this.stats.vectorCandidates += result.vectorCandidateCount
    this.stats.recallGuards += result.recallGuardCount
    this.stats.redundancyRejected += result.redundancyRejectedCount
    this.lastResult = result
    return result
  }

  #retrieveWithVectors(query, viewer, queryPlan, queryVectors) {
    const { sessionId, workspaceId, includeUserGlobal = true } = viewer
    if (!String(sessionId ?? '').trim()) throw new TypeError('sessionId is required')
    this.stats.queries += 1
    this.stats.sensoryQueries += 1
    const sensory = this.sensoryChunks(sessionId)
    let ranked = this.#rankRecords(queryPlan, sensory, queryVectors)
    let searchedBank = false
    if (ranked.selected.length === 0 || ranked.uncoveredSubqueries.length > 0) {
      searchedBank = true
      this.stats.bankQueries += 1
      ranked = this.#rankRecords(queryPlan, [...sensory, ...this.bankChunks(workspaceId, includeUserGlobal)], queryVectors)
    }
    return this.#result(query, viewer, queryPlan, ranked, searchedBank)
  }

  retrieve(query, viewer = {}) {
    const queryPlan = decomposeRetrievalQuery(query, { stopwords: this.config.stopwords })
    const queryVectors = queryPlan.allQueries.map((item) => (typeof this.vectorEncoder?.encodeSync === 'function' ? this.vectorEncoder.encodeSync(item.text) : null))
    return this.#retrieveWithVectors(query, viewer, queryPlan, queryVectors)
  }

  async retrieveAsync(query, viewer = {}) {
    const queryPlan = decomposeRetrievalQuery(query, { stopwords: this.config.stopwords })
    const texts = queryPlan.allQueries.map((item) => item.text)
    const queryVectors = this.vectorEncoder && texts.length
      ? await this.vectorEncoder.encodeBatch(texts, { kind: 'query' })
      : texts.map(() => null)
    return this.#retrieveWithVectors(query, viewer, queryPlan, queryVectors)
  }

  async verifySelected(result, selectedIds, planContext = {}) {
    const allowed = new Map(result.candidates.map((candidate) => [candidate.id, candidate]))
    const resolvedQuery = [planContext.resolvedQuery, ...(planContext.chunkHints ?? [])].map(String).map((value) => value.trim()).filter(Boolean).join(' ') || result.query
    this.stats.resolvedQueryRechecks += 1
    const queryPlan = decomposeRetrievalQuery(resolvedQuery, { stopwords: this.config.stopwords })
    const texts = queryPlan.allQueries.map((item) => item.text)
    const queryVectors = this.vectorEncoder && texts.length ? await this.vectorEncoder.encodeBatch(texts, { kind: 'query' }) : texts.map(() => null)
    const records = unique(selectedIds ?? []).map((id) => allowed.get(String(id))).filter(Boolean)
    const ranked = this.#rankRecords(queryPlan, records, queryVectors)
    const selectedSet = new Set(records.map((record) => record.id))
    const selected = ranked.parents.filter((candidate) => selectedSet.has(candidate.id) && candidate.qualified).slice(0, this.config.parentSelectLimit)
    const verified = selected.length > 0
    const margin = selected[0] ? selected[0].effectiveRelevance - (selected[1]?.effectiveRelevance ?? 0) : 0
    return { selected, verified, margin, resolvedQuery, coveredSubqueries: ranked.coveredSubqueries, uncoveredSubqueries: ranked.uncoveredSubqueries }
  }

  renderCatalog(selected = [], { budgetTokens = Infinity } = {}) {
    const entries = clipWholeParents(selected.slice(0, this.config.parentSelectLimit), budgetTokens)
    if (!entries.length) return null
    const blocks = entries.map((item) => {
      const seq = item.sourceRefs.map((ref) => ref.seq).filter(Number.isFinite)
      return `## [[chunk:${item.id}]] [parent] [${item.layer}] [seq ${seq[0] ?? '?'}-${seq.at(-1) ?? '?'}]\n${item.coreText}`
    })
    const prompt = `（卸载上下文证据：以下是 Child 检索命中的完整 Parent current view；被动曝光不计关联。需要审计原始事件时使用 sensory_open(chunk)。）\n<memory-parents>\n${blocks.join('\n\n')}\n</memory-parents>`
    return { prompt, entries, estimatedTokens: estimateTokens(prompt), parentEvidenceTokens: estimateTokens(prompt) }
  }

  status() {
    return {
      ...this.stats,
      architecture: 'parent-child-vector-v2',
      config: { ...this.config, stopwords: this.config.stopwords.size },
      vectorEncoder: this.vectorEncoder?.status?.() ?? null,
      lastResult: lastResultStatus(this.lastResult),
    }
  }
}

export { decomposeRetrievalQuery, lexicalTokens }
export { SENSORY as SENSORY_LEDGER_COLLECTION }
