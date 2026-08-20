import { randomUUID } from 'node:crypto'

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function messageText(message) {
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.map((block) => {
    if (typeof block === 'string') return block
    if (typeof block?.text === 'string') return block.text
    if (Array.isArray(block?.content)) return block.content.map((part) => part?.text ?? '').join(' ')
    return ''
  }).filter(Boolean).join('\n')
}

function rawMessageOf(event) {
  if (!event || typeof event !== 'object') return null
  if (event.type === 'user/message') return { ...clone(event.data), role: event.data?.role ?? 'user' }
  if (event.type === 'assistant/message') return { ...clone(event.data?.message ?? event.data), role: 'assistant' }
  if (event.type === 'tool/result') return { ...clone(event.data), role: 'tool' }
  return null
}

function turnOf(event) {
  return Number(event?.data?.turn ?? event?.data?.message?.turn ?? event?.turn)
}

function blockKinds(message) {
  if (!Array.isArray(message?.content)) return []
  return message.content.map((block) => String(block?.type ?? 'text'))
}

function sourceKind(message) {
  return String(message?.source?.kind ?? (message?.role === 'tool' ? 'tool' : message?.role ?? 'unknown'))
}

export function eventRecord(event) {
  const message = rawMessageOf(event)
  if (!message) return null
  return {
    seq: event.seq,
    time: event.time ?? Date.now(),
    eventType: event.type,
    role: message.role,
    sourceKind: sourceKind(message),
    source: clone(message.source ?? null),
    messageId: message.id ?? null,
    callId: message.callId ?? message.toolCallId ?? message.tool_call_id ?? null,
    toolName: message.name ?? message.toolName ?? null,
    blockKinds: blockKinds(message),
    text: messageText(message),
    message,
  }
}

export function isPluginProjection(record) {
  return record?.sourceKind === 'plugin'
    && ['sensory-checkpoint', 'sensory-root-manifest', 'semipersistent-snapshot', 'semipersistent-pointer', 'semipersistent-superseded']
      .includes(record?.source?.purpose)
}

export class MemorySegmenter {
  constructor(config = {}) {
    this.config = {
      boundaryReviewEnabled: config.boundaryReviewEnabled !== false,
    }
  }

  recordsForTurn(session, turn) {
    const targetTurn = Number(turn)
    const events = session?.events ?? []
    let startIndex = -1
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.type === 'turn/start' && Number(events[index]?.data?.turn) === targetTurn) startIndex = index
    }
    const selectedEvents = startIndex >= 0
      ? events.slice(startIndex, events.findIndex((event, index) => index > startIndex && event?.type === 'turn/start') >= 0
        ? events.findIndex((event, index) => index > startIndex && event?.type === 'turn/start')
        : events.length)
      : events
    const records = []
    let activeTurn = null
    for (const event of selectedEvents) {
      if (event?.type === 'turn/start') activeTurn = Number(event?.data?.turn)
      const explicitTurn = turnOf(event)
      const eventTurn = Number.isFinite(explicitTurn) ? explicitTurn : activeTurn
      const record = eventTurn === targetTurn ? eventRecord(event) : null
      if (record && !isPluginProjection(record)) records.push(record)
      if (event?.type === 'turn/end' && Number(event?.data?.turn) === activeTurn) activeTurn = null
    }
    return records.sort((left, right) => Number(left.seq) - Number(right.seq))
  }

  buildTurnSegment({ session, turn, workspaceId, cwd = null, boundaryReason = 'turn-complete' }) {
    const records = this.recordsForTurn(session, turn)
    if (records.length === 0) return null
    const sourceSeqs = records.map((record) => record.seq).filter(Number.isFinite)
    const firstSeq = sourceSeqs.length ? Math.min(...sourceSeqs) : null
    const lastSeq = sourceSeqs.length ? Math.max(...sourceSeqs) : null
    const user = records.find((record) => record.role === 'user' && record.sourceKind !== 'tool')
    const segmentId = `seg-${String(session.id)}-${String(turn)}-${firstSeq ?? randomUUID()}`
    return {
      id: segmentId,
      segmentId,
      sessionId: String(session.id),
      workspaceId: String(workspaceId),
      cwd,
      turn: Number(turn),
      firstSeq,
      lastSeq,
      sourceSeqs,
      records,
      userText: user?.text ?? '',
      sealedAt: Date.now(),
      boundaryReason,
      openTask: false,
      pinned: false,
      importance: 0.5,
      durability: 0.5,
      evidenceQuality: user?.text?.trim() ? 0.85 : 0.5,
      extractionConfidence: 0.6,
      verifiedSource: Boolean(user?.text?.trim()),
      associations: [],
      surfaceRevision: 0,
      replacementLineage: [],
      state: 'working',
      createdAt: records[0]?.time ?? Date.now(),
      updatedAt: Date.now(),
    }
  }

  seal(segment, { boundaryReason = segment?.boundaryReason ?? 'turn-complete', openTask = false } = {}) {
    return {
      ...clone(segment),
      sealedAt: segment?.sealedAt ?? Date.now(),
      boundaryReason,
      openTask: Boolean(openTask),
      updatedAt: Date.now(),
    }
  }
}
