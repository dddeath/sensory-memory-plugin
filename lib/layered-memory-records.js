import { resolve } from 'node:path'

import { ContextChunker } from './context-chunker.js'

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
    state: 'sensory',
    createdAt: chunk.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }))
}
