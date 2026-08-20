const STOP_WORDS = new Set([
  '一个', '另外', '已经', '好的', '请记住', '因为', '被占用', '待配置', '已安装',
])

function entityTypeOf(name) {
  if (/^客户#\d+$/.test(name)) return 'person'
  if (/^项目[A-Z]$/.test(name)) return 'project'
  return 'generic'
}

function keywordsFor(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = new Set()
  for (const match of normalized.matchAll(/[a-z][\w-]*|\d+/g)) tokens.add(match[0])
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let width = 2; width <= 4; width += 1) {
      for (let index = 0; index + width <= run.length; index += 1) {
        const token = run.slice(index, index + width)
        if (!STOP_WORDS.has(token)) tokens.add(token)
      }
    }
  }
  return [...tokens]
}

function collectMatches(text, expression, mapper, output, occupied) {
  for (const match of text.matchAll(expression)) {
    const name = mapper(match)
    if (!name) continue
    const start = match.index
    const end = start + match[0].length
    output.push({ name, start, end })
    occupied.push([start, end])
  }
}

function isInsideSpan(start, end, spans) {
  return spans.some(([spanStart, spanEnd]) => start >= spanStart && end <= spanEnd)
}

function extractFacts(text) {
  const facts = new Set()
  const patterns = [
    /客户#\d+\s*偏好\s*[A-Za-z0-9][\w-]*/g,
    /客户#\d+\s*的[\u4e00-\u9fff]{1,8}\s*是\s*[A-Za-z0-9][\w-]*/g,
    /项目[A-Z]\s*的[\u4e00-\u9fff]{1,10}\s*是\s*[A-Za-z0-9][\w-]*/g,
    /[A-Za-z][\w-]*\s*=\s*[^，。；;\r\n]+/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      facts.add(match[0].replace(/\s+/g, ''))
    }
  }
  return [...facts]
}

function cleanEndpoint(value) {
  return String(value ?? '').trim().replace(/^[，。；;：:\s]+|[，。；;：:\s]+$/g, '')
}

function extractRelations(text, sourceRef) {
  const relations = []
  const patterns = [
    { expression: /((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))\s*依赖\s*((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))/g, type: 'depends_on' },
    { expression: /((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))\s*属于\s*((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))/g, type: 'belongs_to' },
    { expression: /((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))\s*使用\s*((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))/g, type: 'uses' },
    { expression: /((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))\s*导致\s*((?:客户#\d+|项目[A-Z]|[A-Za-z][\w-]*|[\u4e00-\u9fff]{2,12}))/g, type: 'causes' },
    { expression: /([A-Za-z][\w-]*)\s+depends\s+on\s+([A-Za-z][\w-]*)/gi, type: 'depends_on' },
    { expression: /([A-Za-z][\w-]*)\s+belongs\s+to\s+([A-Za-z][\w-]*)/gi, type: 'belongs_to' },
    { expression: /([A-Za-z][\w-]*)\s+uses\s+([A-Za-z][\w-]*)/gi, type: 'uses' },
    { expression: /([A-Za-z][\w-]*)\s+causes\s+([A-Za-z][\w-]*)/gi, type: 'causes' },
  ]
  const seen = new Set()
  for (const { expression, type } of patterns) {
    for (const match of text.matchAll(expression)) {
      const fromName = cleanEndpoint(match[1])
      const toName = cleanEndpoint(match[2])
      const key = `${fromName.toLowerCase()}\u0000${type}\u0000${toName.toLowerCase()}`
      if (!fromName || !toName || fromName === toName || seen.has(key)) continue
      seen.add(key)
      relations.push({ fromName, toName, relationType: type, confidence: 0.6, ...(sourceRef ? { sourceRef } : {}) })
    }
  }
  return relations
}

export class ExtractionEngine {
  extractFromText(text, { sessionId, seq, role = 'assistant', scopeId } = {}) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { entities: [], relations: [], observations: [] }
    }

    const candidates = []
    const occupied = []
    collectMatches(text, /客户#\d+/g, (match) => match[0], candidates, occupied)
    collectMatches(text, /项目[A-Z]/g, (match) => match[0], candidates, occupied)
    collectMatches(
      text,
      /端口\s*(?:是|=|:|：)?\s*(\d{2,5})/g,
      (match) => `端口${match[1]}`,
      candidates,
      occupied,
    )

    for (const match of text.matchAll(/[A-Za-z][\w-]*/g)) {
      const start = match.index
      const end = start + match[0].length
      if (!isInsideSpan(start, end, occupied)) candidates.push({ name: match[0], start, end })
    }

    const facts = extractFacts(text)
    const sourceRef = sessionId === undefined || seq === undefined
      ? undefined
      : { sessionId: String(sessionId), seq, ...(scopeId ? { scopeId: String(scopeId) } : {}) }
    const relations = extractRelations(text, sourceRef)
    for (const relation of relations) {
      for (const name of [relation.fromName, relation.toName]) {
        const start = text.toLowerCase().indexOf(name.toLowerCase())
        candidates.push({ name, start: Math.max(0, start), end: Math.max(0, start) + name.length })
      }
    }
    const byName = new Map()
    for (const candidate of candidates) {
      const name = candidate.name.trim()
      if (!name) continue
      const key = name.toLowerCase()
      const relatedFacts = facts.filter((fact) => fact.toLowerCase().includes(key))
      const keywords = keywordsFor([name, ...relatedFacts].join(' '))
      const existing = byName.get(key)
      if (existing) {
        existing.observations = [...new Set([...existing.observations, ...relatedFacts])]
        existing.keywords = [...new Set([...existing.keywords, ...keywords])]
        continue
      }
      byName.set(key, {
        name,
        entityType: entityTypeOf(name),
        observations: relatedFacts,
        keywords,
        confidence: 0.6,
        ...(sourceRef ? { sourceRef } : {}),
      })
    }

    return {
      entities: [...byName.values()],
      relations,
      observations: facts.map((content) => ({ content, role, ...(sourceRef ? { sourceRef } : {}) })),
    }
  }
}
