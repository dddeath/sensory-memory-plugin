import { resolve } from 'node:path'

import { ContextChunker } from './context-chunker.js'
import { estimateTokens } from './context-utils.js'
import { pointerIdFor } from './pointer-label-compressor.js'

export function cloneLayerValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

export function messageText(message) {
  if (typeof message?.text === 'string') return message.text
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .filter(Boolean)
    .join(' ')
}

export function currentUserText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index]?.source?.kind !== 'plugin') {
      return messageText(messages[index]).trim()
    }
  }
  return ''
}

export function normalizedWorkspaceFallback(cwd) {
  return `path:${resolve(String(cwd ?? process.cwd())).replace(/\\/g, '/').toLowerCase()}`
}

export function segmentSourceRefs(segment) {
  return (segment.sourceSeqs ?? []).map((seq) => ({ sessionId: segment.sessionId, seq }))
}

export function canonicalSegmentSourceRefs(segment, trustedEvidenceTools = []) {
  return (segment.records ?? [])
    .filter((record) => (record.role === 'user' && record.sourceKind === 'user')
      || (record.role === 'tool' && trustedEvidenceTools.includes(String(record.toolName ?? ''))))
    .map((record) => ({ sessionId: segment.sessionId, seq: record.seq }))
}

function sourceText(segment) {
  return (segment.records ?? [])
    .filter((record) => !(
      record.sourceKind === 'plugin'
      && ['sensory-checkpoint', 'sensory-root-manifest', 'semipersistent-snapshot', 'semipersistent-pointer']
        .includes(record.source?.purpose)
    ))
    .map((record) => {
      const label = record.role === 'tool' ? `tool:${record.toolName ?? 'result'}` : record.role
      return `[seq ${record.seq}] ${label}: ${String(record.text ?? '')}`
    })
    .filter((line) => line.trim())
    .join('\n')
}

function labelFor(chunk) {
  if (chunk.documentTitle) return String(chunk.documentTitle).slice(0, 80)
  if (chunk.headingPath?.length) return chunk.headingPath.join(' > ').slice(0, 80)
  const first = String(chunk.coreText ?? '').replace(/^\[seq\s+\d+\]\s+\w+(?::\w+)?:\s*/u, '').split('\n')[0].trim()
  return first.slice(0, 80) || chunk.id
}

export function initialSurfacePointer(chunk, overrides = {}) {
  const label = String(overrides.label ?? chunk?.label ?? labelFor(chunk)).replace(/\s+/g, ' ').trim().slice(0, 80)
  return {
    pointerId: String(overrides.pointerId ?? chunk?.pointer?.pointerId ?? pointerIdFor(chunk)),
    mode: String(overrides.mode ?? chunk?.pointer?.mode ?? 'legacy-preview'),
    label,
    eventSeq: Number.isFinite(Number(overrides.eventSeq ?? chunk?.pointer?.eventSeq))
      ? Number(overrides.eventSeq ?? chunk.pointer.eventSeq)
      : null,
    estimatedTokens: Number.isFinite(Number(overrides.estimatedTokens ?? chunk?.pointer?.estimatedTokens))
      ? Number(overrides.estimatedTokens ?? chunk.pointer.estimatedTokens)
      : null,
    revision: Math.max(0, Number(overrides.revision ?? chunk?.pointer?.revision ?? 0)),
  }
}

function segmentBoundaryKey(segment) {
  for (const record of segment?.records ?? []) {
    const source = record?.message?.source ?? record?.source ?? {}
    const benchmarkSession = source?.benchmark?.sessionIndex
    if (benchmarkSession !== undefined && benchmarkSession !== null) return `benchmark:${benchmarkSession}`
  }
  return `session:${String(segment?.sessionId ?? '')}`
}

export function mergeSegmentsToParentGroup(segments, { parentMaxTurns = 8, parentMaxTokens = 3000 } = {}) {
  const ordered = [...(segments ?? [])].sort((left, right) => Number(left.firstSeq) - Number(right.firstSeq))
  if (ordered.length === 0) return null
  if (ordered.length === 1) return cloneLayerValue(ordered[0])
  const sessionId = String(ordered[0].sessionId)
  const workspaceId = String(ordered[0].workspaceId)
  const boundary = segmentBoundaryKey(ordered[0])
  if (ordered.length > parentMaxTurns
    || ordered.some((segment) => String(segment.sessionId) !== sessionId
      || String(segment.workspaceId) !== workspaceId
      || segmentBoundaryKey(segment) !== boundary)) return null
  const sourceParents = ordered.flatMap((segment) => segment.contextChunks ?? [])
  if (sourceParents.length === 0) return null
  const estimatedTokens = sourceParents.reduce((sum, parent) => sum + Math.max(1, Number(parent.tokenCount ?? estimateTokens(parent.coreText))), 0)
  if (estimatedTokens > parentMaxTokens) return null
  const leader = ordered[0]
  const groupId = `group-${sessionId}-${leader.firstSeq}-${ordered.at(-1).lastSeq}`
  const parentId = `${groupId}:parent:001`
  const childSpans = []
  const parts = []
  let offset = 0
  for (const parent of sourceParents) {
    const core = String(parent.coreText ?? '')
    if (!core) continue
    if (parts.length) offset += 1
    parts.push(core)
    for (const child of parent.childSpans ?? []) {
      childSpans.push({
        ...cloneLayerValue(child),
        childId: `${parentId}:child:${String(childSpans.length + 1).padStart(3, '0')}`,
        parentId,
        startOffset: offset + Number(child.startOffset ?? 0),
        endOffset: offset + Number(child.endOffset ?? 0),
      })
    }
    offset += core.length
  }
  const coreText = parts.join('\n')
  const sourceRefs = ordered.flatMap((segment) => segmentSourceRefs(segment))
  const parent = {
    ...cloneLayerValue(sourceParents[0]),
    id: parentId,
    parentId,
    parentIndex: 0,
    parentCount: 1,
    chunkIndex: 0,
    chunkCount: 1,
    documentId: groupId,
    documentTitle: sourceParents.map((item) => item.documentTitle).find(Boolean) ?? '',
    format: 'conversation-group',
    coreText,
    contextText: coreText,
    tokenCount: estimateTokens(coreText),
    contextTokenCount: estimateTokens(coreText),
    childSpans,
    childCount: childSpans.length,
    sourceRefs: cloneLayerValue(sourceRefs),
    evidenceSourceRefs: cloneLayerValue(sourceRefs),
    firstSeq: Number(leader.firstSeq),
    lastSeq: Number(ordered.at(-1).lastSeq),
    span: [Number(leader.firstSeq), Number(ordered.at(-1).lastSeq)],
    segmentId: String(leader.segmentId),
    segmentGroupId: groupId,
    memberSegmentIds: ordered.map((segment) => String(segment.id)),
    sessionId,
    workspaceId,
    evidenceQuality: Math.min(...ordered.map((segment) => Number(segment.evidenceQuality ?? 0))),
    verifiedSource: ordered.every((segment) => segment.verifiedSource !== false),
    associations: ordered.flatMap((segment) => cloneLayerValue(segment.associations ?? [])),
    updatedAt: Date.now(),
  }
  return {
    ...cloneLayerValue(leader),
    segmentGroupId: groupId,
    memberSegmentIds: ordered.map((segment) => String(segment.id)),
    firstSeq: Number(leader.firstSeq),
    lastSeq: Number(ordered.at(-1).lastSeq),
    sourceSeqs: ordered.flatMap((segment) => segment.sourceSeqs ?? []),
    records: ordered.flatMap((segment) => cloneLayerValue(segment.records ?? [])).sort((left, right) => Number(left.seq) - Number(right.seq)),
    contextChunks: [parent],
    chunkCount: 1,
    contentPreview: coreText.slice(0, 240),
    estimatedTokens,
    importance: Math.max(...ordered.map((segment) => Number(segment.importance ?? 0))),
    durability: Math.max(...ordered.map((segment) => Number(segment.durability ?? 0))),
    evidenceQuality: parent.evidenceQuality,
    verifiedSource: parent.verifiedSource,
    createdAt: Math.min(...ordered.map((segment) => Number(segment.createdAt ?? Date.now()))),
    updatedAt: Date.now(),
  }
}

function vectorSpec(vectorEncoder, vector = null) {
  const status = vectorEncoder?.status?.() ?? {}
  return {
    provider: vector?.provider ?? status.provider ?? null,
    model: vector?.model ?? status.model ?? null,
    revision: vector?.revision ?? status.revision ?? null,
    dimensions: vector?.dimensions ?? status.dimensions ?? null,
    normalized: vector?.normalized !== false,
    queryPrefix: status.provider === 'http' ? 'query: ' : null,
    passagePrefix: status.provider === 'http' ? 'passage: ' : null,
  }
}

function activateParents(parents, vectors, vectorEncoder) {
  let offset = 0
  return parents.map((parent) => {
    const childSpans = (parent.childSpans ?? []).map((child) => ({
      ...child,
      vector: vectors[offset++] ?? null,
    }))
    const complete = childSpans.length > 0 && childSpans.every((child) => child.vector)
    return {
      ...parent,
      childSpans,
      childCount: childSpans.length,
      state: complete ? 'active' : 'lexical-only',
      vectorState: complete ? 'active' : 'lexical-only',
      vectorSpec: vectorSpec(vectorEncoder, childSpans[0]?.vector),
      // Compatibility mirror only. Matcher v2 reads childSpans exclusively.
      vector: childSpans[0]?.vector ?? null,
      vectorKey: childSpans[0]?.vector ? `${childSpans[0].vector.model}:${parent.id}:children` : null,
    }
  })
}

export async function enrichSegmentMetadata(segment, { chunker = new ContextChunker(), vectorEncoder = null, onPending = null } = {}) {
  const text = sourceText(segment)
  const sourceRefs = segmentSourceRefs(segment)
  const drafts = chunker.chunkParents(text, {
    segmentId: segment.segmentId,
    sessionId: segment.sessionId,
    turn: segment.turn,
    documentId: `${segment.sessionId}:turn:${segment.turn ?? segment.firstSeq ?? 0}`,
  })
  const pendingParents = drafts.map((parent) => ({
    ...parent,
    label: labelFor(parent),
    sessionId: String(segment.sessionId),
    workspaceId: String(segment.workspaceId),
    segmentId: String(segment.segmentId),
    turn: Number(segment.turn ?? 0),
    sourceRefs: cloneLayerValue(sourceRefs),
    evidenceSourceRefs: cloneLayerValue(sourceRefs),
    evidenceQuality: Number(segment.evidenceQuality ?? 0),
    verifiedSource: sourceRefs.length > 0,
    temporalCurrent: true,
    supersededBy: null,
    associations: cloneLayerValue(segment.associations ?? []),
    createdAt: segment.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }))
  if (typeof onPending === 'function' && pendingParents.length) {
    await onPending({
      ...segment,
      contextChunks: pendingParents,
      chunkCount: pendingParents.length,
      chunking: chunker.status(),
      vectorState: 'pending-vector',
      updatedAt: Date.now(),
    })
  }
  const childTexts = pendingParents.flatMap((parent) => (parent.childSpans ?? []).map((child) => child.embeddingText))
  const vectors = vectorEncoder && childTexts.length > 0
    ? await vectorEncoder.encodeBatch(childTexts, { kind: 'passage' })
    : childTexts.map(() => null)
  const parents = activateParents(pendingParents, vectors, vectorEncoder)
  const contextChunks = parents.map((chunk) => ({
    ...chunk,
    label: labelFor(chunk),
    sessionId: String(segment.sessionId),
    workspaceId: String(segment.workspaceId),
    segmentId: String(segment.segmentId),
    sourceRefs: cloneLayerValue(sourceRefs),
    evidenceSourceRefs: cloneLayerValue(sourceRefs),
    evidenceQuality: Number(segment.evidenceQuality ?? 0),
    verifiedSource: sourceRefs.length > 0,
    temporalCurrent: true,
    supersededBy: null,
    associations: cloneLayerValue(segment.associations ?? []),
    createdAt: segment.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }))
  return {
    ...segment,
    contextChunks,
    chunkCount: contextChunks.length,
    chunking: chunker.status(),
    contentPreview: text.slice(0, 240),
    approvedContext: Boolean(text.trim()),
    verifiedSource: sourceRefs.length > 0,
    vectorState: contextChunks.every((parent) => parent.state === 'active') ? 'active' : 'lexical-only',
    updatedAt: Date.now(),
  }
}

export function sensoryChunksForSegment(segment, { chunker = new ContextChunker(), vectorEncoder = null } = {}) {
  let chunks = cloneLayerValue(segment.contextChunks ?? [])
  if (chunks.length === 0) {
    const fallback = chunker.chunkParents(sourceText(segment), { segmentId: segment.segmentId, sessionId: segment.sessionId, turn: segment.turn })
    const vectors = fallback.flatMap((parent) => (parent.childSpans ?? []).map((child) => (
      typeof vectorEncoder?.encodeSync === 'function' ? vectorEncoder.encodeSync(child.embeddingText) : null
    )))
    chunks = activateParents(fallback, vectors, vectorEncoder).map((chunk) => ({ ...chunk, label: labelFor(chunk) }))
  }
  return chunks.map((chunk) => ({
    ...chunk,
    kind: 'context-parent',
    schemaVersion: 2,
    scopeKind: 'session',
    scopeId: String(segment.sessionId),
    sessionId: String(segment.sessionId),
    workspaceId: String(segment.workspaceId),
    segmentId: String(segment.segmentId),
    sourceRefs: cloneLayerValue(chunk.sourceRefs ?? segmentSourceRefs(segment)),
    evidenceSourceRefs: cloneLayerValue(chunk.evidenceSourceRefs ?? segmentSourceRefs(segment)),
    firstSeq: segment.firstSeq,
    lastSeq: segment.lastSeq,
    span: [segment.firstSeq, segment.lastSeq],
    evidenceQuality: Number(chunk.evidenceQuality ?? segment.evidenceQuality ?? 0),
    verifiedSource: chunk.verifiedSource ?? segment.verifiedSource,
    temporalCurrent: chunk.temporalCurrent !== false,
    supersededBy: chunk.supersededBy ?? null,
    supersededRanges: cloneLayerValue(chunk.supersededRanges ?? []),
    associations: cloneLayerValue(chunk.associations ?? segment.associations ?? []),
    surfaceResidency: chunk.surfaceResidency ?? 'labeled-pointer',
    pointer: initialSurfacePointer(chunk),
    state: 'sensory',
    createdAt: chunk.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }))
}
