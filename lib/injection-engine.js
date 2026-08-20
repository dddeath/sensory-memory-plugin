const GUIDE = '（感知记忆索引：以下为按时间顺序排列的相关记忆入口。请检查它们与当前工作记忆的关联——摘要够用直接用；需细节对 [[实体]] 用 sensory_open 展开；需更广检索用 sensory_recall）'

function textContent(content, { textBlocksOnly = false } = {}) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return textBlocksOnly ? '' : block
      if (!block || typeof block !== 'object') return ''
      if (textBlocksOnly && block.type !== 'text') return ''
      return typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join(' ')
}

function messageText(message, options) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.text === 'string') return message.text
  return textContent(message.content, options)
}

function blocksOf(message) {
  return Array.isArray(message?.content) ? message.content.filter(Boolean) : []
}

function toolCallsOf(message) {
  const calls = []
  for (const call of message?.tool_calls ?? []) {
    calls.push(call?.id ?? call?.toolCallId ?? call?.callId ?? null)
  }
  for (const block of blocksOf(message)) {
    if (!['tool-call', 'tool_call', 'tool-use', 'tool_use'].includes(block?.type)) continue
    calls.push(block.id ?? block.toolCallId ?? block.callId ?? null)
  }
  return calls
}

function toolResultsOf(message) {
  const results = []
  if (message?.role === 'tool') {
    results.push(message.tool_call_id ?? message.toolCallId ?? message.callId ?? null)
  }
  for (const block of blocksOf(message)) {
    if (!['tool-result', 'tool_result', 'tool-output', 'tool_output'].includes(block?.type)) continue
    results.push(block.toolCallId ?? block.tool_call_id ?? block.callId ?? block.id ?? null)
  }
  if (results.length === 0 && message?.source?.kind === 'tool') {
    results.push(message.source.callId ?? message.source.toolCallId ?? null)
  }
  return results
}

function callsAreResolved(calls, results) {
  if (calls.length === 0) return true
  const namedCalls = calls.filter(Boolean).map(String)
  const namedResults = new Set(results.filter(Boolean).map(String))
  if (namedCalls.length === calls.length) return namedCalls.every((id) => namedResults.has(id))
  return results.length >= calls.length
}

export function protectToolPairBoundary(messages, proposedIndex) {
  if (!Array.isArray(messages)) return proposedIndex
  const boundary = Math.max(0, Math.min(messages.length, proposedIndex))
  let assistantIndex = boundary - 1
  while (assistantIndex >= 0 && toolResultsOf(messages[assistantIndex]).length > 0) assistantIndex -= 1
  const calls = toolCallsOf(messages[assistantIndex])
  if (calls.length === 0) return boundary

  const results = []
  for (let index = assistantIndex + 1; index < boundary; index += 1) {
    results.push(...toolResultsOf(messages[index]))
  }
  if (callsAreResolved(calls, results)) return boundary

  let adjusted = boundary
  while (adjusted < messages.length) {
    const current = toolResultsOf(messages[adjusted])
    if (current.length === 0) break
    results.push(...current)
    adjusted += 1
    if (callsAreResolved(calls, results)) return adjusted
  }

  // An incomplete historical tool group is safest when kept wholly after the
  // catalog; inserting before its assistant message preserves provider grammar.
  return assistantIndex
}

function sourceRefsOf(hit) {
  return Array.isArray(hit?.source_refs)
    ? hit.source_refs.filter((ref) => ref && ref.seq !== undefined)
    : []
}

function comparableSeq(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value)
  return null
}

function seqOfHit(hit) {
  const refs = sourceRefsOf(hit)
  const numeric = refs.map((ref) => comparableSeq(ref.seq)).filter((seq) => seq !== null)
  if (numeric.length > 0) return Math.min(...numeric)
  return refs[0]?.seq ?? null
}

function compareSeq(left, right) {
  const leftNumber = comparableSeq(left)
  const rightNumber = comparableSeq(right)
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true })
}

export function estimateTokens(text) {
  let tokens = 0
  let asciiRun = 0
  const flushAscii = () => {
    if (asciiRun > 0) tokens += Math.ceil(asciiRun / 4)
    asciiRun = 0
  }
  for (const character of String(text ?? '')) {
    if (/[^\x00-\x7F]/u.test(character)) {
      flushAscii()
      tokens += 1
    } else {
      asciiRun += 1
    }
  }
  flushAscii()
  return tokens
}

export function extractQuery(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  let lastUser = ''
  let lastAssistant = ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!lastUser && message?.role === 'user' && message?.source?.kind !== 'plugin') {
      lastUser = messageText(message).trim()
    }
    if (!lastAssistant && message?.role === 'assistant') {
      lastAssistant = messageText(message, { textBlocksOnly: true }).trim()
    }
    if (lastUser && lastAssistant) break
  }
  return [lastUser, lastAssistant].filter(Boolean).join(' ')
}

export class InjectionEngine {
  constructor({ matcher, session = null, config = {} }) {
    if (!matcher || typeof matcher.match !== 'function') throw new TypeError('matcher.match is required')
    this.matcher = matcher
    this.config = {
      injectBudgetTokens: Math.min(200, Math.max(1, config.injectBudgetTokens ?? 200)),
      maxCatalogPerTurn: Math.max(1, config.maxCatalogPerTurn ?? 5),
      scoreThreshold: config.rewriteScoreThreshold ?? config.scoreThreshold ?? 0.3,
    }
    this.sessions = new Map()
    this.session = null
    this.lastResult = null
    this.lastInjection = null
    this.priorityCatalog = null
    if (session) this.setSession(session)
  }

  setSession(session) {
    if (!session || !Array.isArray(session.events)) return
    this.session = session
    if (session.id !== undefined) this.sessions.set(String(session.id), session)
  }

  #enrichHit(hit) {
    if (sourceRefsOf(hit).length > 0) return hit
    const entity = hit?.id ? this.matcher.sensoryIndex?.get?.(hit.id) : null
    return entity ? { ...hit, source_refs: entity.source_refs ?? [], observations: entity.observations ?? [] } : hit
  }

  async matchAndRender(queryText, viewer = {}) {
    const started = performance.now()
    const result = await this.matcher.match(queryText, viewer)
    const hits = (result?.engrams ?? []).map((hit) => this.#enrichHit(hit))
    const catalog = hits.length > 0 ? this.renderCatalog(hits) : null
    const renderedHits = catalog ? this.lastRender?.hits ?? [] : []
    this.lastResult = {
      queryText: String(queryText ?? ''),
      hits: renderedHits,
      entrySeqs: renderedHits.map(seqOfHit).filter((seq) => seq !== null),
      catalog,
      durationMs: performance.now() - started,
    }
    return catalog
  }

  matchAndRenderSync(queryText, viewer = {}) {
    if (typeof this.matcher.matchSync !== 'function') throw new TypeError('matcher.matchSync is required')
    const started = performance.now()
    const result = this.matcher.matchSync(queryText, viewer)
    const hits = (result?.engrams ?? []).map((hit) => this.#enrichHit(hit))
    const lowConfidence = Number.isFinite(result?.topScore) && result.topScore < this.config.scoreThreshold
    const catalog = hits.length > 0 && !lowConfidence ? this.renderCatalog(hits) : null
    const renderedHits = catalog ? this.lastRender?.hits ?? [] : []
    this.lastResult = {
      queryText: String(queryText ?? ''),
      hits: renderedHits,
      entrySeqs: renderedHits.map(seqOfHit).filter((seq) => seq !== null),
      catalog,
      score: result?.topScore ?? null,
      lowConfidence,
      durationMs: performance.now() - started,
    }
    return catalog
  }

  renderCatalog(hits = []) {
    const priority = typeof this.priorityCatalog === 'function'
      ? this.priorityCatalog(hits).filter(Boolean)
      : []
    const priorityIds = new Set(priority.map((hit) => hit.id).filter(Boolean))
    const priorityNames = new Set(priority.map((hit) => String(hit.name ?? hit.title).toLowerCase()))
    const normal = hits.filter((hit) => (
      !priorityIds.has(hit?.id)
      && !priorityNames.has(String(hit?.name ?? hit?.title).toLowerCase())
    ))
    const sorted = [...priority]
      .sort((left, right) => compareSeq(seqOfHit(left), seqOfHit(right)))
      .concat([...normal].sort((left, right) => compareSeq(seqOfHit(left), seqOfHit(right))))
      .filter((hit) => hit && (hit.name || hit.title))
      .slice(0, this.config.maxCatalogPerTurn)
    const chosen = []
    const lines = []
    for (const hit of sorted) {
      const name = String(hit.name ?? hit.title).replace(/[\r\n\[\]]+/g, ' ').trim()
      const seq = seqOfHit(hit)
      if (!name || seq === null) continue
      const summary = String(hit.summary ?? hit.observations?.[0] ?? hit.content ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      const marker = hit.cache ? '[cache] ' : ''
      let line = `- ${marker}[[${name}]] [seq ${String(seq)}]${summary ? ` ${summary}` : ''}`
      let candidate = `${GUIDE}\n<memory>\n${[...lines, line].join('\n')}\n</memory>`
      if (estimateTokens(candidate) > this.config.injectBudgetTokens && summary) {
        let reduced = summary
        while (reduced.length > 0 && estimateTokens(candidate) > this.config.injectBudgetTokens) {
          reduced = reduced.slice(0, Math.max(0, reduced.length - Math.max(1, Math.ceil(reduced.length / 5)))).trim()
          line = `- ${marker}[[${name}]] [seq ${String(seq)}]${reduced ? ` ${reduced}…` : ''}`
          candidate = `${GUIDE}\n<memory>\n${[...lines, line].join('\n')}\n</memory>`
        }
      }
      if (estimateTokens(candidate) > this.config.injectBudgetTokens) break
      lines.push(line)
      chosen.push(hit)
    }
    const catalog = lines.length > 0 ? `${GUIDE}\n<memory>\n${lines.join('\n')}\n</memory>` : null
    this.lastRender = { catalog, hits: chosen, estimatedTokens: estimateTokens(catalog) }
    return catalog
  }

  #sessionFor(sessionId) {
    if (sessionId !== undefined && this.sessions.has(String(sessionId))) return this.sessions.get(String(sessionId))
    return this.session
  }

  #messageSeqMap(sessionId) {
    const map = new Map()
    const session = this.#sessionFor(sessionId)
    for (const event of session?.events ?? []) {
      const message = event?.type === 'user/message' ? event.data : event?.data?.message
      if (message?.id !== undefined && comparableSeq(event?.seq) !== null) {
        map.set(String(message.id), comparableSeq(event.seq))
      }
    }
    return map
  }

  locateInsertIndex(messages, entrySeq, sessionId) {
    const target = comparableSeq(entrySeq)
    if (!Array.isArray(messages) || target === null) return null
    const mapped = this.#messageSeqMap(sessionId)
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      const direct = comparableSeq(message?.seq ?? message?.sourceSeq ?? message?.source?.seq)
      const seq = direct ?? (message?.id === undefined ? null : mapped.get(String(message.id)) ?? null)
      if (seq !== null && seq > target) return index
    }
    return null
  }

  inject(messages, catalog, entrySeqs = [], sessionId) {
    if (!Array.isArray(messages) || !catalog) return null
    const numericSeqs = entrySeqs.map(comparableSeq).filter((seq) => seq !== null)
    const minimumSeq = numericSeqs.length > 0 ? Math.min(...numericSeqs) : null
    const located = minimumSeq === null ? null : this.locateInsertIndex(messages, minimumSeq, sessionId)
    const proposedIndex = located ?? messages.length
    const insertIndex = protectToolPairBoundary(messages, proposedIndex)
    const beforeLength = messages.length
    messages.splice(insertIndex, 0, {
      role: 'user',
      content: [{ type: 'text', text: catalog }],
      source: { kind: 'plugin', plugin: '@local/sensory-memory', purpose: 'sensory-catalog-legacy' },
    })
    this.lastInjection = {
      kind: 'legacy-snapshot',
      entrySeqs: [...entrySeqs],
      minimumSeq,
      proposedIndex,
      insertIndex,
      beforeLength,
      afterLength: messages.length,
      fallback: located === null,
      toolBoundaryAdjusted: insertIndex !== proposedIndex,
    }
    return insertIndex
  }
}

export const SENSORY_CATALOG_GUIDE = GUIDE
