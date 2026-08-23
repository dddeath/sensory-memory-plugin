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
  if (chunk.headingPath?.length) return chunk.headingPath.join(' > ').slice(0, 80)
  const first = String(chunk.coreText ?? '').replace(/^\[seq\s+\d+\]\s+\w+(?::\w+)?:\s*/u, '').split('\n')[0].trim()
  return first.slice(0, 80) || chunk.id
}

export async function enrichSegmentMetadata(segment, { chunker = new ContextChunker(), vectorEncoder = null } = {}) {
  const text = sourceText(segment)
  const sourceRefs = segmentSourceRefs(segment)
  const chunks = chunker.chunk(text, { segmentId: segment.segmentId, sessionId: segment.sessionId })
  const vectors = vectorEncoder && chunks.length > 0
    ? await vectorEncoder.encodeBatch(chunks.map((chunk) => chunk.contextText))
    : chunks.map(() => null)
  const contextChunks = chunks.map((chunk, index) => ({
    ...chunk,
    label: labelFor(chunk),
    sessionId: String(segment.sessionId),
    workspaceId: String(segment.workspaceId),
    segmentId: String(segment.segmentId),
    sourceRefs: cloneLayerValue(sourceRefs),
    evidenceSourceRefs: cloneLayerValue(sourceRefs),
    vector: vectors[index],
    vectorKey: vectors[index] ? `${vectors[index].model}:${chunk.id}` : null,
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
    updatedAt: Date.now(),
  }
}

export function sensoryChunksForSegment(segment, { chunker = new ContextChunker(), vectorEncoder = null } = {}) {
  let chunks = cloneLayerValue(segment.contextChunks ?? [])
  if (chunks.length === 0) {
    const fallback = chunker.chunk(sourceText(segment), { segmentId: segment.segmentId, sessionId: segment.sessionId })
    chunks = fallback.map((chunk) => ({
      ...chunk,
      label: labelFor(chunk),
      vector: typeof vectorEncoder?.encodeSync === 'function' ? vectorEncoder.encodeSync(chunk.contextText) : null,
      vectorKey: null,
    }))
  }
  return chunks.map((chunk) => ({
    ...chunk,
    kind: 'context-chunk',
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
    associations: cloneLayerValue(chunk.associations ?? segment.associations ?? []),
    state: 'sensory',
    createdAt: chunk.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  }))
}
