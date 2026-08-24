import { estimateTokens } from './context-utils.js'

function clean(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

function tailByTokens(text, limit) {
  const value = clean(text)
  if (!value || limit <= 0) return ''
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(value.slice(-middle)) <= limit) low = middle
    else high = middle - 1
  }
  return value.slice(-low)
}

function headByTokens(text, limit) {
  const value = clean(text)
  if (!value || limit <= 0) return ''
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(value.slice(0, middle)) <= limit) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function splitOversized(text, hardMaxTokens) {
  const value = clean(text)
  if (!value) return []
  if (estimateTokens(value) <= hardMaxTokens) return [value]
  const units = value
    .split(/(?<=[。！？.!?;；])\s*|\n{2,}|\n(?=(?:[-*+]\s|\d+[.)]\s))/u)
    .map(clean)
    .filter(Boolean)
  if (units.length <= 1) {
    const result = []
    let rest = value
    while (rest) {
      const head = headByTokens(rest, hardMaxTokens)
      if (!head) break
      result.push(head)
      rest = rest.slice(head.length).trimStart()
    }
    return result
  }
  const result = []
  let current = ''
  for (const unit of units) {
    const next = current ? `${current}\n${unit}` : unit
    if (estimateTokens(next) <= hardMaxTokens) {
      current = next
      continue
    }
    if (current) result.push(current)
    const parts = estimateTokens(unit) <= hardMaxTokens ? [unit] : splitOversized(unit, hardMaxTokens)
    result.push(...parts.slice(0, -1))
    current = parts.at(-1) ?? ''
  }
  if (current) result.push(current)
  return result
}

function codeBlocks(text, language) {
  const lines = clean(text).split('\n')
  const starts = []
  const patterns = language === 'python'
    ? [/^\s*(?:async\s+def|def|class)\s+[A-Za-z_]\w*/]
    : [
        /^\s*(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*/,
        /^\s*(?:export\s+)?class\s+[A-Za-z_$][\w$]*/,
        /^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
        /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/,
      ]
  for (let index = 0; index < lines.length; index += 1) {
    if (patterns.some((pattern) => pattern.test(lines[index]))) starts.push(index)
  }
  if (starts.length === 0) return [{ format: 'code', language, coreText: clean(text), headingPath: [] }]
  if (starts[0] > 0) starts.unshift(0)
  return starts.map((start, index) => ({
    format: 'code',
    language,
    coreText: clean(lines.slice(start, starts[index + 1] ?? lines.length).join('\n')),
    headingPath: [],
  })).filter((block) => block.coreText)
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function markdownBlocks(text) {
  const lines = clean(text).split('\n')
  const blocks = []
  const headingPath = []
  let paragraph = []
  const flushParagraph = () => {
    const coreText = clean(paragraph.join('\n'))
    if (coreText) blocks.push({ format: 'markdown', language: null, coreText, headingPath: [...headingPath] })
    paragraph = []
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      headingPath.splice(level - 1)
      headingPath[level - 1] = clean(heading[2])
      index += 1
      continue
    }
    const fence = line.match(/^\s*```([^\s`]*)\s*$/)
    if (fence) {
      flushParagraph()
      const body = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) body.push(lines[index++])
      if (index < lines.length) index += 1
      const language = String(fence[1] || 'text').toLowerCase()
      for (const block of codeBlocks(body.join('\n'), language)) blocks.push({ ...block, headingPath: [...headingPath] })
      continue
    }
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph()
      const header = line
      const separator = lines[index + 1]
      const rows = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(lines[index++])
      for (const row of rows.length ? rows : ['']) {
        blocks.push({
          format: 'markdown-table',
          language: null,
          coreText: clean(row),
          contextPrefix: `${header}\n${separator}`,
          headingPath: [...headingPath],
          rowCount: row ? 1 : 0,
        })
      }
      continue
    }
    if (!line.trim()) flushParagraph()
    else paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return blocks
}

function looksLikeMarkdown(text) {
  return /(^|\n)#{1,6}\s+|(^|\n)```|\n\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/m.test(text)
}

function looksLikeCode(text, language) {
  if (language && language !== 'text' && language !== 'markdown') return true
  return /(^|\n)\s*(?:async\s+def|def|class|function|const\s+\w+\s*=|import\s+|export\s+)/m.test(text)
}

function sameStructuralParent(left, right) {
  return left?.format === right?.format
    && left?.format !== 'code'
    && left?.language === right?.language
    && String(left?.contextPrefix ?? '') === String(right?.contextPrefix ?? '')
    && JSON.stringify(left?.headingPath ?? []) === JSON.stringify(right?.headingPath ?? [])
}

function mergeSmallBlocks(blocks, targetTokens) {
  const merged = []
  for (const block of blocks) {
    const previous = merged.at(-1)
    const combined = previous ? `${previous.coreText}\n${block.coreText}` : block.coreText
    if (previous && sameStructuralParent(previous, block) && estimateTokens(combined) <= targetTokens) {
      previous.coreText = combined
      previous.rowCount = Number(previous.rowCount ?? 0) + Number(block.rowCount ?? 0)
      continue
    }
    merged.push({ ...block })
  }
  return merged
}

function documentInputs(text, metadata) {
  if (!Array.isArray(metadata.documents) || metadata.documents.length === 0) {
    const value = clean(text)
    const marker = /^---\s+(.+?)\s+---\s*$/gm
    const matches = [...value.matchAll(marker)]
    if (matches.length > 0) {
      return matches.map((match, index) => {
        const start = Number(match.index) + match[0].length
        const end = Number(matches[index + 1]?.index ?? value.length)
        return {
          id: `${String(metadata.documentId ?? metadata.segmentId ?? metadata.id ?? 'document')}:doc:${String(index + 1).padStart(3, '0')}`,
          title: clean(match[1]),
          text: clean(value.slice(start, end)),
          format: metadata.format,
          language: metadata.language,
        }
      }).filter((document) => document.text)
    }
    return [{
      id: String(metadata.documentId ?? metadata.segmentId ?? metadata.id ?? 'document'),
      title: clean(metadata.documentTitle ?? metadata.title),
      text: value,
      format: metadata.format,
      language: metadata.language,
    }]
  }
  return metadata.documents.map((document, index) => ({
    id: String(document.id ?? document.documentId ?? `document-${index + 1}`),
    title: clean(document.title ?? document.documentTitle),
    text: clean(document.text ?? document.content),
    format: document.format ?? metadata.format,
    language: document.language ?? metadata.language,
  })).filter((document) => document.text)
}

function structuralBlocks(text, { format, language } = {}) {
  const normalizedLanguage = String(language ?? '').toLowerCase() || null
  if (format === 'markdown' || looksLikeMarkdown(text)) return markdownBlocks(text)
  if (format === 'code' || looksLikeCode(text, normalizedLanguage)) return codeBlocks(text, normalizedLanguage ?? 'text')
  return [{ format: 'text', language: null, coreText: clean(text), headingPath: [] }]
}

function inferDocumentTitle(document, blocks) {
  if (document.title) return document.title.slice(0, 160)
  const heading = blocks.find((block) => block.headingPath?.length)?.headingPath?.[0]
  if (heading) return String(heading).slice(0, 160)
  return ''
}

function locateCoreOffsets(parentText, cores) {
  let cursor = 0
  return cores.map((core) => {
    let startOffset = parentText.indexOf(core, cursor)
    if (startOffset < 0) startOffset = cursor
    const endOffset = startOffset + core.length
    cursor = endOffset
    return { startOffset, endOffset }
  })
}

function childDrafts(parent, config) {
  const split = splitOversized(parent.coreText, config.childMaxTokens)
    .map((coreText) => ({
      format: parent.format,
      language: parent.language,
      headingPath: parent.headingPath,
      coreText,
    }))
  const cores = mergeSmallBlocks(split, config.childTargetTokens)
  const offsets = locateCoreOffsets(parent.coreText, cores.map((item) => item.coreText))
  return cores.map((block, index) => {
    const before = tailByTokens(cores[index - 1]?.coreText, config.childOverlapTokens)
    const after = headByTokens(cores[index + 1]?.coreText, config.childOverlapTokens)
    const heading = block.headingPath?.length ? block.headingPath.join(' > ') : ''
    const embeddingText = [parent.documentTitle, heading, parent.contextPrefix, before, block.coreText, after].filter(Boolean).join('\n')
    return {
      childId: `${parent.id}:child:${String(index + 1).padStart(3, '0')}`,
      childIndex: index,
      startOffset: offsets[index].startOffset,
      endOffset: offsets[index].endOffset,
      tokenCount: estimateTokens(block.coreText),
      headingPath: block.headingPath ?? [],
      embeddingText,
      embeddingTextPreview: embeddingText.slice(0, 240),
      vector: null,
      temporalCurrent: true,
      supersededBy: null,
      supersedes: [],
      overlap: {
        beforeChars: before.length,
        afterChars: after.length,
        factsFromCoreOnly: true,
      },
    }
  })
}

export class ContextChunker {
  constructor(config = {}) {
    const legacyMax = config.chunkMaxTokens
    const legacyTarget = config.chunkTargetTokens
    const legacyOverlap = config.chunkOverlapTokens
    this.config = {
      parentTargetTokens: Math.max(64, config.parentTargetTokens ?? legacyTarget ?? 2048),
      parentMaxTokens: Math.max(96, config.parentMaxTokens ?? legacyMax ?? 3072),
      parentMinTokens: Math.max(1, config.parentMinTokens ?? (legacyMax ? Math.min(legacyMax, 64) : 512)),
      childTargetTokens: Math.max(32, config.childTargetTokens ?? (legacyMax ? Math.min(legacyMax, legacyTarget ?? 320) : 384)),
      childMaxTokens: Math.max(48, config.childMaxTokens ?? (legacyMax ? legacyMax : 512)),
      childOverlapTokens: Math.max(0, config.childOverlapTokens ?? legacyOverlap ?? 64),
    }
    if (this.config.parentTargetTokens > this.config.parentMaxTokens) this.config.parentTargetTokens = this.config.parentMaxTokens
    if (this.config.childTargetTokens > this.config.childMaxTokens) this.config.childTargetTokens = this.config.childMaxTokens
  }

  chunkParents(text, metadata = {}) {
    const documents = documentInputs(text, metadata)
    const segmentId = String(metadata.segmentId ?? metadata.id ?? 'segment')
    const parents = []
    for (const document of documents) {
      const structural = structuralBlocks(document.text, document)
      const split = structural.flatMap((block) => {
      const parts = block.format === 'markdown-table'
        ? [block.coreText]
        : splitOversized(block.coreText, this.config.parentMaxTokens)
        return parts.map((coreText) => ({ ...block, coreText, oversized: estimateTokens(coreText) > this.config.parentMaxTokens }))
      })
      const cores = mergeSmallBlocks(split, this.config.parentTargetTokens)
      const documentTitle = inferDocumentTitle(document, cores)
      for (const block of cores) {
        const index = parents.length
        const id = `${segmentId}:parent:${String(index + 1).padStart(3, '0')}`
        const parent = {
        id,
        parentId: id,
        kind: 'context-parent',
        schemaVersion: 2,
        parentIndex: index,
        chunkIndex: index,
        documentId: document.id,
        documentTitle,
        format: block.format,
        language: block.language,
        headingPath: block.headingPath ?? [],
        contextPrefix: block.contextPrefix ?? '',
        rowCount: block.rowCount ?? 0,
        oversized: Boolean(block.oversized),
        coreText: block.coreText,
        contextText: block.coreText,
        tokenCount: estimateTokens(block.coreText),
        contextTokenCount: estimateTokens(block.coreText),
        state: 'pending-vector',
        vectorState: 'pending-vector',
        childSpans: [],
        supersededRanges: [],
        temporalCurrent: true,
      }
        parent.childSpans = childDrafts(parent, this.config)
        parent.childCount = parent.childSpans.length
        parents.push(parent)
      }
    }
    return parents.map((parent) => ({ ...parent, parentCount: parents.length, chunkCount: parents.length }))
  }

  chunk(text, metadata = {}) { return this.chunkParents(text, metadata) }

  status() {
    return { kind: 'parent-child-structure-v2', schemaVersion: 2, tokenEstimator: 'dsh-char-estimator-v1', ...this.config }
  }
}

export const contextChunkInternals = { codeBlocks, markdownBlocks, splitOversized }
