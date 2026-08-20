import { adaptSensoryIndex } from './engram-adapter.js'
import { NgramHashAddressing } from './hash.js'
import { CausalGraph } from '../vendor/causal.js'
import { SemanticScorer } from '../vendor/semantic-scorer.js'
import { EngramWakeEngine } from '../vendor/wake.js'

function publicHit(node) {
  return {
    id: node.id,
    name: node.title,
    summary: node.summary,
    content: node.content,
    source_refs: node.source_refs ?? [],
    ...(node.scopeId ? { scopeId: node.scopeId } : {}),
  }
}

function lexicalTokens(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const match of normalized.matchAll(/[a-z][\w-]*|\d+/g)) tokens.add(match[0])
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let width = 2; width <= 3; width += 1) {
      for (let index = 0; index + width <= run.length; index += 1) {
        tokens.add(run.slice(index, index + width))
      }
    }
  }
  return tokens
}

function hasLexicalAnchor(query, node) {
  const queryTokens = lexicalTokens(query)
  if (queryTokens.size === 0) return false
  const nodeTokens = lexicalTokens(`${node.title} ${node.summary} ${node.content}`)
  return [...queryTokens].some((token) => nodeTokens.has(token))
}

export class MatchEngine {
  constructor(sensoryIndex, config = {}) {
    this.sensoryIndex = sensoryIndex
    this.adapter = adaptSensoryIndex(sensoryIndex)
    this.graph = new CausalGraph(this.adapter)
    this.scorer = new SemanticScorer(this.adapter)
    this.maxWakePerTurn = config.maxWakePerTurn ?? 3
    this.indexScope = config.indexScope === 'session' ? 'session' : 'global'
    this.maxQueryChars = Math.max(200, config.maxQueryChars ?? 900)
    this.maxSemanticCandidates = Math.max(8, config.maxSemanticCandidates ?? 64)
    this.stats = {
      queries: 0,
      truncatedQueries: 0,
      semanticCandidates: 0,
      semanticCandidatesFiltered: 0,
      noHit: 0,
    }
    this.onHit = null
    this.engine = new EngramWakeEngine(
      this.adapter,
      this.graph,
      new NgramHashAddressing(),
      {
        injectBudgetTokens: config.injectBudgetTokens ?? 200,
        maxWakePerTurn: this.maxWakePerTurn,
        lessonMinScore: config.lessonMinScore ?? 0.42,
        lessonBudgetTokens: config.lessonBudgetTokens ?? 60,
        wakeSampleLog: false,
        tauSem: config.tauSem ?? 1,
        tauTime: config.tauTime ?? 0,
        tauCause: config.tauCause ?? 0,
        recencyWeight: config.recencyWeight ?? 0,
      },
      {
        // SemanticScorer returns score details; EngramWakeEngine consumes numbers.
        scorer: async (query, candidates) => {
          const details = this.scorer.score(query, candidates)
          const normalizedQuery = String(query).toLowerCase()
          return new Map(candidates.map((candidate) => {
            const base = details.get(candidate.id)?.score ?? 0
            const titleAnchor = candidate.title
              && normalizedQuery.includes(String(candidate.title).toLowerCase()) ? 1 : 0
            return [candidate.id, base + titleAnchor]
          }))
        },
      },
    )
  }

  markDirty() {
    this.graph.rebuild()
    this.scorer.cooc?.markDirty?.()
  }

  warm() {
    this.scorer.cooc?.ensure?.()
  }

  #notifyHits(engrams, viewer = {}) {
    if (typeof this.onHit !== 'function') return
    for (const engram of engrams) this.onHit(engram.id, viewer)
  }

  scopeFor(viewer = {}) {
    return this.indexScope === 'session'
      ? String(viewer.scopeId ?? viewer.sessionId ?? 'global')
      : 'global'
  }

  matchSync(query, _viewer = {}) {
    this.stats.queries += 1
    const text = String(query ?? '')
    const scopeId = this.scopeFor(_viewer)
    if (text.length > this.maxQueryChars) this.stats.truncatedQueries += 1
    const tail = Math.min(200, Math.floor(this.maxQueryChars / 3))
    const material = text.length > this.maxQueryChars
      ? `${text.slice(0, this.maxQueryChars - tail)} ${text.slice(-tail)}`
      : text
    const normalizedQuery = material.toLowerCase()
    const queryTokens = new Set([...lexicalTokens(material)].slice(0, 160))
    const ids = new Set()
    for (const entity of this.sensoryIndex.all(scopeId)) {
      for (const title of [entity.name, ...(entity.aliases ?? [])].map((value) => String(value).toLowerCase())) {
        if ((title.length >= 2 || /^\d+$/.test(title)) && normalizedQuery.includes(title)) ids.add(entity.id)
      }
    }
    for (const token of queryTokens) {
      if (token.length < 2 && !/^\d+$/.test(token)) continue
      for (const id of this.sensoryIndex.tokenIndex?.get(token) ?? []) {
        if (!this.sensoryIndex.inScope(id, scopeId)) {
          this.stats.semanticCandidatesFiltered += 1
          continue
        }
        ids.add(id)
        if (ids.size >= this.maxSemanticCandidates) break
      }
      if (ids.size >= this.maxSemanticCandidates) break
    }
    this.stats.semanticCandidates += ids.size
    const ranked = [...ids].map((id) => this.sensoryIndex.get(id, scopeId)).filter(Boolean).map((entity) => {
      const title = String(entity.name ?? '').toLowerCase()
      const titleAnchor = title && normalizedQuery.includes(title) ? 1000 : 0
      const entityTokens = new Set([
        ...lexicalTokens(entity.name),
        ...(entity.keywords ?? []).map((value) => String(value).toLowerCase()),
      ])
      const overlap = [...queryTokens].reduce((score, token) => score + (entityTokens.has(token) ? 1 : 0), 0)
      const normalizedScore = titleAnchor > 0 ? 1 : overlap / Math.max(1, queryTokens.size)
      return { entity, score: titleAnchor + overlap, normalizedScore }
    })
    ranked.sort((left, right) => right.score - left.score
      || String(left.entity.name).localeCompare(String(right.entity.name)))
    const exactAnchored = ranked.some(({ score }) => score >= 1000)
      ? ranked.filter(({ score }) => score >= 1000)
      : ranked
    const engrams = exactAnchored.slice(0, this.maxWakePerTurn)
      .map(({ entity }) => this.adapter.get(entity.id))
      .filter(Boolean)
    this.#notifyHits(engrams, _viewer)
    if (engrams.length === 0) this.stats.noHit += 1
    return {
      engrams: engrams.map(publicHit),
      reason: engrams.length > 0 ? 'matched' : 'no-semantic-overlap',
      injectedTokens: 0,
      topScore: exactAnchored[0]?.normalizedScore ?? 0,
    }
  }

  async match(query, viewer = {}) {
    const scopeId = this.scopeFor(viewer)
    if (this.indexScope === 'session') return this.matchSync(query, { ...viewer, scopeId })
    this.stats.queries += 1
    const text = String(query ?? '')
    if (text.length > this.maxQueryChars) this.stats.truncatedQueries += 1
    const material = text.length > this.maxQueryChars
      ? `${text.slice(0, this.maxQueryChars - 200)} ${text.slice(-200)}`
      : text
    const result = await this.engine.query(
      material,
      this.maxWakePerTurn,
      viewer,
      { auto: true },
    )
    const lexical = result.engrams.filter((node) => hasLexicalAnchor(material, node))
    const engrams = lexical.filter((node) => this.sensoryIndex.inScope(node.id, scopeId))
    this.stats.semanticCandidates += result.engrams.length
    this.stats.semanticCandidatesFiltered += result.engrams.length - engrams.length
    this.#notifyHits(engrams, viewer)
    if (engrams.length === 0) this.stats.noHit += 1
    return {
      engrams: engrams.map(publicHit),
      reason: engrams.length > 0 || result.reason === 'no-hash-hit'
        ? result.reason
        : 'no-semantic-overlap',
      injectedTokens: engrams.length > 0 ? result.injectedTokens : 0,
    }
  }

  status() {
    return {
      ...this.stats,
      indexScope: this.indexScope,
      maxQueryChars: this.maxQueryChars,
      semanticFilterRate: this.stats.semanticCandidates === 0
        ? 0
        : this.stats.semanticCandidatesFiltered / this.stats.semanticCandidates,
    }
  }
}
