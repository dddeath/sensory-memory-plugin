function toTimestamp(value, fallback = Date.now()) {
  return Number.isFinite(value) ? value : fallback
}

export function toEngramNode(entity, sensoryIndex) {
  if (!entity || entity.type !== 'entity') return null
  const observations = Array.isArray(entity.observations) ? entity.observations : []
  const title = String(entity.name ?? '')
  const summary = observations[0] ?? ''
  const content = observations.join('\n')
  const material = [title, ...observations, ...(entity.keywords ?? [])].join(' ')
  const createdAt = toTimestamp(entity.valid_from)
  return {
    id: entity.id,
    kind: 'fact',
    layer: 'global',
    projectId: null,
    title,
    summary,
    content,
    links: [],
    tags: [],
    sessionId: entity.source_refs?.at(-1)?.sessionId ?? null,
    turn: Number.isFinite(entity.source_refs?.at(-1)?.seq) ? entity.source_refs.at(-1).seq : 0,
    causes: [],
    effects: [],
    importance: Number.isFinite(entity.confidence) ? entity.confidence : 0.6,
    createdAt,
    lastHitAt: entity.last_hit_at ?? createdAt,
    hits: entity.hit_count ?? 0,
    reinforces: entity.last_hit_at ? [entity.last_hit_at] : [createdAt],
    status: 'active',
    source_refs: entity.source_refs ?? [],
    scopeId: entity.scopeId ?? 'global',
    slots: sensoryIndex.hasher.slotKeys(sensoryIndex.hasher.hash(material)),
  }
}

/**
 * Present the stage-1 SensoryIndex through the zero-dependency engram store API.
 * The vendored wake engine consumes node objects from lookup(), not ids.
 */
export function adaptSensoryIndex(sensoryIndex) {
  const map = (entity) => toEngramNode(entity, sensoryIndex)
  return {
    dir: sensoryIndex.indexDir,
    count: (scopeId = null) => sensoryIndex.count(scopeId),
    all: (scopeId = null) => sensoryIndex.all(scopeId).map(map).filter(Boolean),
    get: (id, scopeId = null) => map(sensoryIndex.get(id, scopeId)),
    getMany: (ids = [], scopeId = null) => ids.map((id) => map(sensoryIndex.get(id, scopeId))).filter(Boolean),
    byTitle: (title, scopeId = 'global') => map(sensoryIndex.getEntityByName(title, scopeId)),
    lookup: (query, limit, scopeId = 'global') => sensoryIndex.lookup(query, limit, scopeId).map(map).filter(Boolean),
    touch: (id, scopeId = null) => map(sensoryIndex.touch(id, scopeId)),
  }
}
