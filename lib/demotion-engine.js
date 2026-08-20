function uniqueStrings(values = []) {
  return [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))]
}

function keywordsFor(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const match of normalized.matchAll(/[a-z][\w-]*|\d+/g)) tokens.add(match[0])
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let width = 2; width <= 4; width += 1) {
      for (let index = 0; index + width <= run.length; index += 1) {
        tokens.add(run.slice(index, index + width))
      }
    }
  }
  return [...tokens]
}

function normalizedKind(message) {
  if (message?.kind === 'reasoning' || message?.type === 'reasoning') return 'reasoning'
  if (message?.kind === 'tool' || message?.role === 'tool' || message?.toolName) return 'tool'
  return 'message'
}

function messageText(message) {
  if (typeof message === 'string') return message
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) {
    return message.content
      .map((block) => {
        if (typeof block === 'string') return block
        if (typeof block?.text === 'string') return block.text
        if (Array.isArray(block?.content)) return messageText({ content: block.content })
        if (typeof block?.output === 'string') return block.output
        if (block?.output !== undefined) return JSON.stringify(block.output)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export class IndexSourceStore {
  constructor(index) {
    this.index = index
  }

  save(item) {
    return this.index.writeSource(
      { sessionId: item.sessionId, seq: item.sourceSeq },
      {
        key: item.key,
        turn: item.turn,
        role: item.role,
        kind: item.kind,
        text: item.text,
      },
    )
  }
}

export class DemotionEngine {
  constructor({ index, extractor, sourceStore, matcher = null, config = {} }) {
    this.index = index
    this.extractor = extractor
    this.sourceStore = sourceStore ?? new IndexSourceStore(index)
    this.matcher = matcher
    this.config = {
      toolRounds: config.toolRounds ?? 3,
      msgRounds: config.msgRounds ?? 5,
      demoteReasoning: config.demoteReasoning ?? true,
      indexScope: config.indexScope === 'session' ? 'session' : 'global',
    }
    this.state = index.readRounds()
  }

  threshold(item) {
    if (item.kind === 'reasoning') return this.config.demoteReasoning ? 0 : Infinity
    return item.kind === 'tool' ? this.config.toolRounds : this.config.msgRounds
  }

  scopeForSession(sessionId) {
    return this.config.indexScope === 'session' ? String(sessionId ?? 'global') : 'global'
  }

  async isReferenced(item, queryText, matchedNames = null) {
    const query = String(queryText ?? '').trim().toLowerCase()
    if (!query) return false
    const entityNames = Array.isArray(item.entityNames) ? item.entityNames : []
    const keywords = Array.isArray(item.keywords) ? item.keywords : []
    if (entityNames.some((name) => query.includes(name.toLowerCase()))) return true
    if (keywords.some((keyword) => keyword.length >= 2 && query.includes(keyword))) return true
    if (!this.matcher && !matchedNames) return false
    const matched = matchedNames ?? new Set((await this.matcher.match(query, {
      sessionId: item.sessionId,
      scopeId: item.scopeId,
    })).engrams.map((entry) => entry.name.toLowerCase()))
    return entityNames.some((name) => matched.has(name.toLowerCase()))
  }

  async demote(item) {
    if (item.demoted) return { key: item.key, demoted: false, reason: 'already-demoted', entityIds: [] }
    const scopeId = item.scopeId ?? this.scopeForSession(item.sessionId)
    const sourceRef = { sessionId: item.sessionId, seq: item.sourceSeq, scopeId }
    const extracted = this.extractor.extractFromText(item.text, {
      ...sourceRef,
      role: item.role,
    })
    const entityIds = []
    for (const entity of extracted.entities) entityIds.push(this.index.addEntity({ ...entity, scopeId }))
    for (const relation of extracted.relations) {
      const from = relation.from ?? this.index.getEntityByName(relation.fromName, scopeId)?.id
      const to = relation.to ?? this.index.getEntityByName(relation.toName, scopeId)?.id
      if (from && to) this.index.addRelation({ ...relation, from, to, scopeId })
    }
    this.sourceStore.save(item)
    item.demoted = true
    item.demotedAt = Date.now()
    item.entityIds = entityIds
    item.entityNames = uniqueStrings(extracted.entities.map((entity) => entity.name))
    this.index.flush()
    this.matcher?.markDirty?.()
    return { key: item.key, demoted: true, entityIds, sourceRef }
  }

  async demoteBySeq(sourceSeq, sessionId) {
    const matches = this.state.tracked.filter((item) => (
      String(item.sourceSeq) === String(sourceSeq)
      && (sessionId === undefined || String(item.sessionId) === String(sessionId))
    ))
    if (matches.length === 0) {
      return { sourceSeq, demoted: false, reason: 'source-seq-not-found', results: [] }
    }
    const results = []
    for (const item of matches) results.push(await this.demote(item))
    this.index.writeRounds(this.state)
    this.matcher?.warm?.()
    return {
      sourceSeq,
      demoted: results.some((result) => result.demoted),
      results,
    }
  }

  async onTurnEnd({ turn, messages = [], queryText = '', sessionId }) {
    const results = []

    let matchedNames = null
    const query = String(queryText ?? '').trim()
    if (query && this.matcher) {
      const hit = await this.matcher.match(query, {
        sessionId,
        scopeId: this.scopeForSession(sessionId),
      })
      matchedNames = new Set(hit.engrams.map((entry) => entry.name.toLowerCase()))
    }

    for (const item of this.state.tracked) {
      if (item.demoted) continue
      if (this.config.indexScope === 'session' && String(item.sessionId) !== String(sessionId)) continue
      item.unrefCount = await this.isReferenced(item, queryText, matchedNames) ? 0 : (item.unrefCount ?? 0) + 1
      if (item.unrefCount >= this.threshold(item)) results.push(await this.demote(item))
    }

    const known = new Set(this.state.tracked.map((item) => item.key))
    let ordinal = 0
    for (const message of messages) {
      const text = messageText(message).trim()
      if (!text) continue
      const kind = normalizedKind(message)
      const role = String(message?.role ?? (kind === 'tool' ? 'tool' : 'assistant'))
      const sourceSeq = message?.sourceSeq ?? message?.seq ?? message?.id ?? `${turn}-${ordinal}`
      const toolName = message?.toolName ?? message?.name ?? 'result'
      const blockSuffix = message?.blockIndex === undefined ? ordinal : message.blockIndex
      const key = `${String(sessionId)}:${String(sourceSeq)}:${kind}:${kind === 'tool' ? toolName : role}:${blockSuffix}`
      ordinal += 1
      if (known.has(key)) continue
      const extracted = this.extractor.extractFromText(text, { sessionId, seq: sourceSeq, role })
      const item = {
        key,
        sourceSeq,
        sessionId: String(sessionId),
        scopeId: this.scopeForSession(sessionId),
        turn,
        role,
        kind,
        toolName: kind === 'tool' ? String(toolName) : undefined,
        text,
        keywords: uniqueStrings([
          ...keywordsFor(text),
          ...extracted.entities.flatMap((entity) => entity.keywords ?? []),
        ]),
        entityNames: uniqueStrings(extracted.entities.map((entity) => entity.name)),
        unrefCount: 0,
        demoted: false,
      }
      this.state.tracked.push(item)
      known.add(key)
      if (this.threshold(item) === 0) results.push(await this.demote(item))
    }

    this.index.writeRounds(this.state)
    if (results.some((result) => result.demoted)) this.matcher?.warm?.()
    return {
      turn,
      tracked: this.state.tracked.length,
      demoted: results.filter((result) => result.demoted).length,
      results,
    }
  }

  async finalizeSession(sessionId) {
    const results = []
    for (const item of this.state.tracked) {
      if (item.demoted || String(item.sessionId) !== String(sessionId)) continue
      results.push(await this.demote(item))
    }
    this.index.writeRounds(this.state)
    if (results.some((result) => result.demoted)) this.matcher?.warm?.()
    return { sessionId: String(sessionId), demoted: results.filter((result) => result.demoted).length, results }
  }

  dropScope(sessionId) {
    const scopeId = this.scopeForSession(sessionId)
    return { sessionId: String(sessionId), ...this.clearScope(scopeId) }
  }

  clearScope(scopeId = 'global') {
    const scope = String(scopeId ?? 'global') || 'global'
    const before = this.state.tracked.length
    this.state.tracked = this.state.tracked.filter((item) => String(item.scopeId ?? 'global') !== scope)
    this.index.writeRounds(this.state)
    return { scopeId: scope, removedTracked: before - this.state.tracked.length }
  }
}

export const messageTextOf = messageText
