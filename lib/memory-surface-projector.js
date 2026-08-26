import { randomUUID } from 'node:crypto'

import { estimateTokens, protectToolPairBoundary } from './context-utils.js'

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }

function pluginMessage(purpose, text, attributes = {}) {
  return {
    id: `memory_${purpose}_${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: {
      kind: 'plugin',
      plugin: '@local/sensory-memory',
      sourcePlugin: '@local/sensory-memory',
      purpose,
      ...attributes,
    },
  }
}

function firstClaimedIndex(messages, claimed) {
  let index = messages.findIndex((message) => claimed.includes(message))
  if (index < 0) index = Math.max(0, messages.length - 1)
  return protectToolPairBoundary(messages, index)
}

function eventMessage(event) {
  if (!event) return null
  if (event.data?.message?.role) return event.data.message
  if (event.data?.role) return event.data
  if (event.message?.role) return event.message
  return null
}

export function estimateInputTokens({ system = '', tools = [], messages = [] } = {}) {
  const toolText = JSON.stringify(tools ?? [])
  const messageText = JSON.stringify(messages ?? [])
  return {
    version: 'layered-char-v1',
    system: estimateTokens(system),
    tools: estimateTokens(toolText),
    messages: estimateTokens(messageText),
    total: estimateTokens(system) + estimateTokens(toolText) + estimateTokens(messageText),
  }
}

export class MemorySurfaceProjector {
  constructor({ ledger, tokenMeter = null, config = {} }) {
    this.ledger = ledger
    this.tokenMeter = tokenMeter
    this.config = {
      contextPressureRatio: Math.max(0.1, Math.min(0.95, config.contextPressureRatio ?? 0.65)),
      contextPressureTargetRatio: Math.max(0.05, Math.min(0.9, config.contextPressureTargetRatio ?? 0.55)),
      semipersistentBudgetRatio: Math.max(0.01, Math.min(0.8, config.semipersistentBudgetRatio ?? 0.20)),
      effectiveInputCapTokens: Number(config.effectiveInputCapTokens) > 0
        ? Math.floor(Number(config.effectiveInputCapTokens))
        : null,
    }
    this.lastProjection = new Map()
    this.lastBudget = new Map()
  }

  #surfaceEvent(session, seq) {
    return session?.events?.[seq] ?? session?.events?.find?.((event) => Number(event?.seq) === Number(seq)) ?? null
  }

  #appendShadowPrice(session, start, end) {
    if (!this.tokenMeter?.estimateMessage || !session?.append) return []
    const visible = session?.surface?.nodes ? [...session.surface.nodes].map(Number) : []
    const shadowedSeqs = visible.filter((seq) => seq >= start && seq <= end)
    if (shadowedSeqs.length === 0) return []
    const shadowedTokenCount = shadowedSeqs.reduce((total, seq) => {
      const message = eventMessage(this.#surfaceEvent(session, seq))
      return total + (message ? Number(this.tokenMeter.estimateMessage(message) ?? 0) : 0)
    }, 0)
    session.append('compaction/prune', {
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount,
      producer: '@local/sensory-memory',
    })
    return shadowedSeqs
  }

  #replace(session, type, data, start, end) {
    const sourceEventSeqs = this.#appendShadowPrice(session, start, end)
    return session.append(type, data, {
      surfaceOp: { op: 'replace', start, end },
      ...(sourceEventSeqs.length ? { sourceEventSeqs } : {}),
    })
  }

  replaceSegment(session, segment, { purpose = 'sensory-checkpoint', text, expectedRevision = segment.surfaceRevision ?? 0, transition = 'working-to-sensory' } = {}) {
    if (!session?.append) throw new TypeError('session.append is required for surface replacement')
    if (Number(segment.surfaceRevision ?? 0) !== Number(expectedRevision)) {
      return { ok: false, reason: 'surface-revision-drift', expectedRevision, actualRevision: segment.surfaceRevision ?? 0 }
    }
    const start = Number(segment.firstSeq)
    const end = Number(segment.lastSeq)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return { ok: false, reason: 'invalid-source-range' }
    const visible = session?.surface?.nodes ? new Set([...session.surface.nodes].map(Number)) : null
    if (visible && ![...visible].some((seq) => seq >= start && seq <= end)) {
      const lineage = {
        transition,
        purpose,
        start,
        end,
        replacementSeq: null,
        fromRevision: expectedRevision,
        toRevision: expectedRevision,
        surfaceAlreadyAbsent: true,
        at: Date.now(),
      }
      return { ok: true, skipped: true, reason: 'source-range-not-visible', event: null, message: null, lineage, surfaceRevision: expectedRevision }
    }
    const message = pluginMessage(purpose, text, {
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      transition,
      sourceRefs: clone(segment.sourceSeqs ?? []),
      surfaceRevision: expectedRevision + 1,
    })
    const event = this.#replace(session, 'user/message', message, start, end)
    const lineage = {
      transition,
      purpose,
      start,
      end,
      replacementSeq: event?.seq ?? null,
      fromRevision: expectedRevision,
      toRevision: expectedRevision + 1,
      at: Date.now(),
    }
    return { ok: true, event, message, lineage, surfaceRevision: expectedRevision + 1 }
  }

  sensoryCheckpoint(entry) {
    const preview = String(entry.coreText ?? '').replace(/\s+/g, ' ').slice(0, 240)
    return `（卸载上下文 Parent 检查点）[[chunk:${entry.id}]] [span ${entry.firstSeq}-${entry.lastSeq}]\n${preview}\n[children: ${entry.childSpans?.length ?? 0}; vector: ${entry.vectorSpec?.model ?? entry.vector?.model ?? entry.vectorState ?? 'pending'} / ${entry.vectorSpec?.dimensions ?? entry.vector?.dimensions ?? 0}d]\n[sourceRefs: ${(entry.sourceRefs ?? []).map((ref) => ref.seq).join(', ')}]`
  }

  semipersistentPointer(record) {
    return `（半持久上下文指针）[[chunk:${record.id}]] 已移入当前会话的半持久快照。 [sourceRefs: ${(record.sourceSeqs ?? []).join(', ')}]`
  }

  prepareSemipersistentSnapshot(session, semi) {
    const prior = [...(session?.deriveMessages?.() ?? [])]
      .reverse()
      .find((message) => message?.source?.kind === 'plugin' && message?.source?.purpose === 'semipersistent-snapshot')
    if (!semi?.prompt && !prior) return { semi: null, action: 'none' }
    if (!prior) return { semi, action: 'insert' }
    if (!semi?.prompt) {
      const priorEvent = [...(session?.events ?? [])].reverse().find((event) => eventMessage(event)?.id === prior.id)
      if (!priorEvent || !Number.isFinite(Number(priorEvent.seq)) || !session?.append) return { semi: null, action: 'empty-without-supersede', messageId: prior.id ?? null }
      const replacement = pluginMessage('semipersistent-superseded', '（半持久记忆快照已失活；当前无完整半持久投影。）', {
        replacesMessageId: prior.id,
        previousSnapshotRevision: prior.source?.snapshotRevision ?? null,
        snapshotRevision: null,
      })
      const event = this.#replace(session, 'user/message', replacement, Number(priorEvent.seq), Number(priorEvent.seq))
      return { semi: null, action: 'supersede-to-empty', messageId: prior.id, eventSeq: event?.seq ?? null }
    }
    if (String(prior.source?.snapshotRevision ?? '') === String(semi.snapshotRevision ?? '')) {
      return { semi: null, action: 'reuse', messageId: prior.id ?? null, snapshotRevision: semi.snapshotRevision }
    }
    const priorEvent = [...(session?.events ?? [])]
      .reverse()
      .find((event) => eventMessage(event)?.id && eventMessage(event).id === prior.id)
    if (!priorEvent || !Number.isFinite(Number(priorEvent.seq)) || !session?.append) {
      return { semi, action: 'insert-without-supersede', messageId: prior.id ?? null, snapshotRevision: semi.snapshotRevision }
    }
    const replacement = pluginMessage('semipersistent-superseded',
      `（半持久记忆快照 ${prior.source?.snapshotRevision ?? 'previous'} 已被更新版本替代。）`, {
        replacesMessageId: prior.id,
        previousSnapshotRevision: prior.source?.snapshotRevision ?? null,
        snapshotRevision: semi.snapshotRevision,
      })
    const event = this.#replace(session, 'user/message', replacement, Number(priorEvent.seq), Number(priorEvent.seq))
    return { semi, action: 'supersede-and-insert', messageId: prior.id, eventSeq: event?.seq ?? null, snapshotRevision: semi.snapshotRevision }
  }

  renderMessages({ decision, claimed = [], sessionId, turn, step, semi = null, catalog = null, rootManifest = null }) {
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return { decision, inserted: [] }
    const messages = [...decision.messages]
    let index = firstClaimedIndex(messages, claimed)
    const injected = []
    const add = (purpose, text, attributes = {}) => {
      if (!text) return
      const message = pluginMessage(purpose, text, { sessionId: String(sessionId), turn, step, ...attributes })
      messages.splice(index, 0, message)
      injected.push({ purpose, index, message })
      index += 1
    }
    add('sensory-root-manifest', rootManifest)
    add('semipersistent-snapshot', semi?.prompt, {
      entryCount: semi?.entries?.length ?? 0,
      estimatedTokens: semi?.estimatedTokens ?? 0,
      snapshotRevision: semi?.snapshotRevision ?? null,
    })
    add('sensory-catalog', catalog?.prompt, {
      entryCount: catalog?.entries?.length ?? 0,
      estimatedTokens: catalog?.estimatedTokens ?? 0,
      parentEvidenceTokens: catalog?.parentEvidenceTokens ?? 0,
      architecture: 'parent-child-vector-v2',
    })
    this.lastProjection.set(String(sessionId), { turn, step, injected: clone(injected), at: Date.now() })
    return { decision: { ...decision, messages }, inserted: injected }
  }

  budget({ sessionId, session = null, contextWindow, maxOutputTokens = 0, request = {}, semipersistentTokens = 0 }) {
    const routedUsable = Math.max(1, Number(contextWindow) - Number(maxOutputTokens || 0))
    const usable = this.config.effectiveInputCapTokens === null
      ? routedUsable
      : Math.max(1, this.config.effectiveInputCapTokens)
    const estimate = estimateInputTokens(request)
    let meter = null
    if (session && typeof this.tokenMeter?.measure === 'function') {
      try { meter = this.tokenMeter.measure(session) } catch {}
    }
    const measuredInputTokens = Math.max(0, Number(meter?.totalTokens ?? estimate.total))
    const pressure = measuredInputTokens / usable
    const result = {
      estimator: estimate.version,
      pressureSource: meter ? `dsh-token-meter:${meter.baseline?.kind ?? 'unknown'}` : estimate.version,
      contextWindow: Number(contextWindow),
      maxOutputTokens: Number(maxOutputTokens || 0),
      routedUsableInputTokens: routedUsable,
      effectiveInputCapTokens: this.config.effectiveInputCapTokens,
      effectiveInputCapSource: this.config.effectiveInputCapTokens === null ? 'resolved-model' : 'explicit-config',
      usableInputTokens: usable,
      estimatedInputTokens: measuredInputTokens,
      requestEstimatedInputTokens: estimate.total,
      dshTokenMeter: meter ? {
        totalTokens: Number(meter.totalTokens),
        surfaceTokens: Number(meter.surfaceTokens),
        baselineKind: meter.baseline?.kind ?? null,
        logRevision: Number(meter.logRevision),
      } : null,
      pressure,
      pressureTriggered: pressure >= this.config.contextPressureRatio,
      pressureThresholdTokens: Math.floor(usable * this.config.contextPressureRatio),
      pressureTargetTokens: Math.floor(usable * this.config.contextPressureTargetRatio),
      semipersistentBudgetTokens: Math.floor(usable * this.config.semipersistentBudgetRatio),
      semipersistentTokens,
      components: estimate,
    }
    this.lastBudget.set(String(sessionId), result)
    return result
  }

  reconcile(session, segments = []) {
    const surface = session?.deriveMessages?.() ?? []
    const pluginPurposes = new Set(surface.filter((message) => message?.source?.kind === 'plugin').map((message) => message.source.purpose))
    const visibleSeqs = session?.surface?.nodes ? new Set([...session.surface.nodes].map(Number)) : null
    const externalCompactionRanges = (session?.events ?? []).filter((event) => {
      if (visibleSeqs && !visibleSeqs.has(Number(event?.seq))) return false
      const source = eventMessage(event)?.source
      return source?.kind === 'plugin' && source?.plugin === 'compact' && event?.surfaceOp?.op === 'replace'
    }).map((event) => ({
      start: Number(event.surfaceOp.start),
      end: Number(event.surfaceOp.end),
      replacementSeq: Number(event.seq),
      compactionId: eventMessage(event)?.source?.compactionId ?? null,
    })).filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    const sensoryExpected = segments.some((segment) => segment.state === 'sensory')
    const semiExpected = segments.some((segment) => segment.state === 'semipersistent')
    return {
      sessionId: String(session?.id ?? ''),
      surfaceMessageCount: surface.length,
      pluginPurposes: [...pluginPurposes],
      restoreSensoryManifest: sensoryExpected && !pluginPurposes.has('sensory-checkpoint') && !pluginPurposes.has('sensory-root-manifest'),
      restoreSemipersistentSnapshot: semiExpected && !pluginPurposes.has('semipersistent-snapshot'),
      externalCompactionDetected: externalCompactionRanges.length > 0,
      externalCompactionRanges,
    }
  }

  status(sessionId) {
    return { lastProjection: clone(this.lastProjection.get(String(sessionId)) ?? null), budget: clone(this.lastBudget.get(String(sessionId)) ?? null), config: clone(this.config) }
  }
}

export { pluginMessage as createMemoryPluginMessage }
