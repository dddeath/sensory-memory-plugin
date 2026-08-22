import { resolve } from 'node:path'

import { parseRememberDirective } from './memory-policy.js'
import { buildRetrievalFeatures, retrievalTermIsSafe } from './memory-retrieval-features.js'

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

function sensoryTitle(segment, entity, index) {
  if (index === 0 && segment?.title) return segment.title
  return entity?.name ?? `session-${segment.sessionId}-turn-${segment.turn}-${index + 1}`
}

function factsFromEntity(entity, segment, trustedEvidenceTools) {
  const observation = String(entity?.observations?.[0] ?? '').trim()
  if (!observation) return []
  return [{
    subject: entity.name,
    predicate: 'states',
    value: observation,
    validFrom: segment.createdAt,
    validTo: null,
    current: true,
    sourceRefs: canonicalSegmentSourceRefs(segment, trustedEvidenceTools),
  }]
}

function meaningfulEntity(entity) {
  const name = String(entity?.name ?? '').trim()
  if (!name || !retrievalTermIsSafe(name) || /^(?:in|to|on|a|user|llm)$/iu.test(name) || /^[a-z]$/iu.test(name)) return false
  return !/^(?:https?:\/\/|[a-z]:\\|\/|\.\.?\/)/iu.test(name)
}

export function enrichSegmentMetadata(segment, { extractor, trustedEvidenceTools = [] }) {
  const userText = segment.records
    .filter((record) => record.role === 'user' && record.sourceKind === 'user')
    .map((record) => record.text)
    .join('\n')
  const directive = parseRememberDirective(userText)
  const extractionText = directive?.content ?? userText
  const userSeq = segment.records.find((record) => record.role === 'user' && record.sourceKind === 'user')?.seq ?? segment.firstSeq
  const extracted = extractor.extractFromText(extractionText, { sessionId: segment.sessionId, seq: userSeq, role: 'user' })
  const entities = (extracted.entities ?? []).filter(meaningfulEntity)
  const retrieval = buildRetrievalFeatures(extractionText, {
    entities,
    sourceRefs: canonicalSegmentSourceRefs(segment, trustedEvidenceTools),
  })
  return {
    ...segment,
    title: retrieval.title ?? entities[0]?.name ?? `session-${segment.sessionId}-turn-${segment.turn}`,
    entities,
    retrievalFeatureVersion: retrieval.retrievalFeatureVersion,
    retrievalTerms: retrieval.retrievalTerms,
    retrievalAliases: retrieval.aliases,
    evidenceSourceRefs: retrieval.evidenceSourceRefs,
    canonicalFacts: entities.flatMap((entity) => factsFromEntity(entity, segment, trustedEvidenceTools)),
    episodeSummary: userText.slice(0, 500),
    approvedEpisode: Boolean(userText.trim()),
    memoryType: /(?:偏好|喜欢|prefer)/iu.test(userText) ? 'preference' : 'verified-fact',
    evidenceQuality: userText.trim() ? Math.max(0.85, Number(segment.evidenceQuality ?? 0)) : Number(segment.evidenceQuality ?? 0),
    verifiedSource: Boolean(userText.trim()),
  }
}

export function sensoryEntriesForSegment(segment, { trustedEvidenceTools = [] } = {}) {
  const entities = segment.entities?.length
    ? segment.entities
    : [{ name: segment.title, observations: [], aliases: segment.retrievalAliases ?? [], checkpointOnly: true }]
  return entities.filter(meaningfulEntity).map((entity, index) => {
    const title = sensoryTitle(segment, entity, index)
    return {
      id: `${segment.id}:sensory:${index}`,
      kind: 'checkpoint',
      scopeKind: 'session',
      scopeId: segment.sessionId,
      sessionId: segment.sessionId,
      workspaceId: segment.workspaceId,
      segmentId: segment.id,
      title,
      aliases: [...new Set([...(entity.aliases ?? []), ...(index === 0 ? segment.retrievalAliases ?? [] : [])])]
        .filter((alias) => alias !== title)
        .slice(0, 8),
      retrievalFeatureVersion: segment.retrievalFeatureVersion ?? 1,
      retrievalTerms: cloneLayerValue(segment.retrievalTerms ?? []),
      evidenceSourceRefs: cloneLayerValue(segment.evidenceSourceRefs ?? []),
      canonicalFacts: entity.checkpointOnly
        ? cloneLayerValue(segment.canonicalFacts ?? [])
        : factsFromEntity(entity, segment, trustedEvidenceTools),
      episodeSummary: String(entity.observations?.[0] ?? segment.episodeSummary ?? '').slice(0, 500),
      approvedEpisode: true,
      sourceRefs: segmentSourceRefs(segment),
      firstSeq: segment.firstSeq,
      lastSeq: segment.lastSeq,
      span: [segment.firstSeq, segment.lastSeq],
      parentId: null,
      level: 0,
      evidenceQuality: segment.evidenceQuality,
      verifiedSource: segment.verifiedSource,
      associations: cloneLayerValue(segment.associations ?? []),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  })
}
