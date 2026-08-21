const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'i', 'in', 'is', 'it', 'llm', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'user', 'was', 'were', 'with',
])

const GENERIC = new Set(['in', 'to', 'on', 'a', 'user', 'llm', 'ok'])
const TITLE_SUFFIXES = ['测试场景', '情景定义', '场景定义', '场景', '项目', '系统', '服务', '模块', '任务', '记录']

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function normalizedKey(value) {
  return normalize(value).toLowerCase()
}

function unsafeTerm(value) {
  const text = normalize(value)
  const key = text.toLowerCase()
  if (text.length < 2 || text.length > 64) return true
  if (GENERIC.has(key) || STOPWORDS.has(key) || /^[a-z]$/iu.test(text)) return true
  const lexicalParts = key.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  if (lexicalParts.length > 0 && lexicalParts.every((part) => STOPWORDS.has(part) || GENERIC.has(part))) return true
  if (/https?:\/\/|\bscm=|```|`[^`]*`|[a-z]:\\|(?:^|\s)\.{0,2}\/[\w./-]+/iu.test(text)) return true
  if (/[{}<>]=>|\b(?:const|let|var|function|npm|node|powershell|bash|cmd\.exe)\b/iu.test(text)) return true
  return false
}

function cloneRefs(sourceRefs) {
  const seen = new Set()
  const output = []
  for (const ref of sourceRefs ?? []) {
    if (ref?.sessionId === undefined || ref?.seq === undefined) continue
    const item = { sessionId: String(ref.sessionId), seq: ref.seq, ...(ref.scopeId ? { scopeId: String(ref.scopeId) } : {}) }
    const key = `${item.sessionId}\u0000${String(item.seq)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function trimGenericSuffix(value) {
  const text = normalize(value)
  for (const suffix of TITLE_SUFFIXES) {
    if (!text.endsWith(suffix)) continue
    const trimmed = normalize(text.slice(0, -suffix.length))
    if (trimmed.length >= 2) return trimmed
  }
  return null
}

function relationParts(text) {
  const output = []
  const chinese = /([^，,；;。！？!?：:\n]{2,32}?)(位于|放在|是|为|使用|属于|依赖|导致)([^，,；;。！？!?\n]{1,64})/gu
  for (const match of text.matchAll(chinese)) {
    output.push({ value: match[1], kind: 'subject' })
    output.push({ value: match[3], kind: 'value' })
  }
  const english = /\b([A-Za-z][\w-]{1,63})\s+(uses|belongs\s+to|depends\s+on|causes|is)\s+([^,;.\n]{1,64})/giu
  for (const match of text.matchAll(english)) {
    output.push({ value: match[1], kind: 'subject' })
    output.push({ value: match[3], kind: 'value' })
  }
  return output
}

export function buildRetrievalFeatures(text, { entities = [], sourceRefs = [], limit = 32 } = {}) {
  const input = normalize(text)
  const refs = cloneRefs(sourceRefs)
  const terms = []
  const seen = new Set()
  const add = (value, kind) => {
    const cleaned = normalize(value).replace(/^[\s，,；;。！？!?：:'"“”‘’【】]+|[\s，,；;。！？!?：:'"“”‘’【】]+$/gu, '')
    const key = normalizedKey(cleaned)
    if (!key || unsafeTerm(cleaned) || seen.has(key) || terms.length >= Math.max(1, limit)) return null
    seen.add(key)
    const term = { value: cleaned, kind: String(kind), sourceRefs: cloneRefs(refs) }
    terms.push(term)
    return term
  }

  for (const entity of entities ?? []) {
    add(entity?.name, 'entity')
    for (const alias of entity?.aliases ?? []) add(alias, 'alias')
    for (const keyword of entity?.keywords ?? []) add(keyword, 'keyword')
  }

  for (const match of input.matchAll(/【([^】]{2,64})】/gu)) {
    add(match[1], 'label')
    add(trimGenericSuffix(match[1]), 'name')
  }
  for (const match of input.matchAll(/(?:^|[。；;！？!?\n])\s*([^：:\n]{2,64})\s*[：:]/gu)) {
    if (/[【】“”"'‘’]/u.test(match[1])) continue
    const afterDelimiter = input.slice((match.index ?? 0) + match[0].length)
    if (afterDelimiter.startsWith('//')) continue
    add(match[1], 'label')
    add(trimGenericSuffix(match[1]), 'name')
  }
  for (const match of input.matchAll(/(?:代号|名称|名字|项目名?|场景名?)(?:是|为|叫|：|:)?\s*[“"'‘]([^”"'’]{2,64})[”"'’]/gu)) add(match[1], 'name')
  for (const part of relationParts(input)) add(part.value, part.kind)
  for (const match of input.matchAll(/[“"'‘]([^”"'’]{2,64})[”"'’]/gu)) add(match[1], 'literal')
  for (const match of input.matchAll(/\b(?=[A-Za-z0-9_-]{2,64}\b)(?=[A-Za-z0-9_-]*[\d_-])[A-Za-z0-9_-]+\b/gu)) add(match[0], 'literal')
  for (const match of input.matchAll(/\b\d{2,}\b/gu)) add(match[0], 'literal')

  const titleTerm = terms.find((term) => term.kind === 'label')
    ?? terms.find((term) => term.kind === 'name')
    ?? terms.find((term) => term.kind === 'entity')
    ?? terms.find((term) => term.kind === 'subject')
    ?? null
  const aliases = terms
    .filter((term) => ['name', 'entity', 'alias', 'label'].includes(term.kind) && term.value !== titleTerm?.value)
    .map((term) => term.value)
    .slice(0, 8)

  return {
    retrievalFeatureVersion: 1,
    retrievalTerms: terms,
    evidenceSourceRefs: refs,
    title: titleTerm?.value ?? null,
    aliases,
  }
}

export function retrievalTermIsSafe(value) {
  return !unsafeTerm(value)
}
