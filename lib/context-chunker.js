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

export class ContextChunker {
  constructor(config = {}) {
    this.config = {
      targetTokens: Math.max(64, config.chunkTargetTokens ?? 320),
      hardMaxTokens: Math.max(96, config.chunkMaxTokens ?? 448),
      overlapTokens: Math.max(0, config.chunkOverlapTokens ?? 48),
    }
    if (this.config.targetTokens > this.config.hardMaxTokens) this.config.targetTokens = this.config.hardMaxTokens
  }

  chunk(text, metadata = {}) {
    const value = clean(text)
    if (!value) return []
    const language = String(metadata.language ?? '').toLowerCase() || null
    let structural
    if (looksLikeMarkdown(value)) structural = markdownBlocks(value)
    else if (looksLikeCode(value, language)) structural = codeBlocks(value, language ?? 'text')
    else structural = [{ format: 'text', language: null, coreText: value, headingPath: [] }]

    const split = structural.flatMap((block) => {
      const parts = block.format === 'markdown-table'
        ? [block.coreText]
        : splitOversized(block.coreText, this.config.hardMaxTokens)
      return parts.map((coreText) => ({ ...block, coreText, oversized: estimateTokens(coreText) > this.config.hardMaxTokens }))
    })
    const cores = mergeSmallBlocks(split, this.config.targetTokens)
    const segmentId = String(metadata.segmentId ?? metadata.id ?? 'segment')
    return cores.map((block, index) => {
      const before = tailByTokens(cores[index - 1]?.coreText, this.config.overlapTokens)
      const after = headByTokens(cores[index + 1]?.coreText, this.config.overlapTokens)
      const heading = block.headingPath?.length ? `# ${block.headingPath.join(' > ')}` : ''
      const contextText = [heading, block.contextPrefix, before, block.coreText, after].filter(Boolean).join('\n')
      return {
        id: `${segmentId}:chunk:${String(index + 1).padStart(3, '0')}`,
        kind: 'context-chunk',
        chunkIndex: index,
        chunkCount: cores.length,
        format: block.format,
        language: block.language,
        headingPath: block.headingPath ?? [],
        rowCount: block.rowCount ?? 0,
        oversized: Boolean(block.oversized),
        coreText: block.coreText,
        contextText,
        tokenCount: estimateTokens(block.coreText),
        contextTokenCount: estimateTokens(contextText),
        overlap: {
          beforeChars: before.length,
          afterChars: after.length,
          factsFromCoreOnly: true,
        },
      }
    })
  }

  status() {
    return { kind: 'structure-first', tokenEstimator: 'dsh-char-estimator-v1', ...this.config }
  }
}

export const contextChunkInternals = { codeBlocks, markdownBlocks, splitOversized }
