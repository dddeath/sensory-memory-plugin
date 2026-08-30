import { estimateTokens } from './context-utils.js'

const LOW_INFORMATION = /^(?:记录|内容|上下文|对话|消息|信息|讨论|相关|用户|助手|context|record|message|discussion)$/iu

function cleanLabel(value) {
  return String(value ?? '')
    .replace(/^\[seq\s+\d+\]\s+\w+(?::\w+)?:\s*/iu, '')
    .replace(/[`*_#>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function trimLowInformation(value) {
  const words = cleanLabel(value).split(/\s+/u).filter(Boolean)
  while (words.length > 1 && LOW_INFORMATION.test(words.at(-1))) words.pop()
  return words.join(' ')
}

export function pointerIdFor(parent) {
  const first = Math.max(0, Number(parent?.firstSeq ?? parent?.sourceRefs?.[0]?.seq ?? 0)).toString(36)
  const last = Math.max(0, Number(parent?.lastSeq ?? parent?.sourceRefs?.at?.(-1)?.seq ?? parent?.sourceRefs?.[0]?.seq ?? 0)).toString(36)
  const index = Math.max(0, Number(parent?.parentIndex ?? 0)).toString(36)
  return `p${first}-${last}-${index}`
}

export function labelForPointer(parent, { maxCharacters = 32 } = {}) {
  const candidates = [
    parent?.documentTitle,
    Array.isArray(parent?.headingPath) ? parent.headingPath.join(' ') : '',
    parent?.label,
    String(parent?.coreText ?? '').split('\n')[0],
  ]
  const selected = candidates.map(trimLowInformation).find((value) => value && !LOW_INFORMATION.test(value))
    ?? pointerIdFor(parent)
  return [...selected].slice(0, Math.max(1, Number(maxCharacters))).join('').trim()
}

export function compactLabelForPointer(parent, { maxCharacters = 12 } = {}) {
  const source = labelForPointer(parent, { maxCharacters: 64 })
  const parts = source.split(/[\s,，。:：/|>_-]+/u).filter(Boolean)
  const protectedParts = parts.filter((part) => /\d|[A-Z][A-Za-z0-9_-]*|[\u3400-\u9fff]{2,}/u.test(part))
  const selected = (protectedParts.length ? protectedParts : parts).slice(0, 3).join(' ')
  return [...(selected || source)].slice(0, Math.max(1, Number(maxCharacters))).join('').trim()
}

export function renderParentPointer(parent, { mode = 'labeled', maxTokens = 24, maxLabelCharacters = 32 } = {}) {
  const pointerId = String(parent?.pointer?.pointerId ?? pointerIdFor(parent))
  const firstSeq = Number(parent?.firstSeq ?? parent?.sourceRefs?.[0]?.seq ?? 0)
  const lastSeq = Number(parent?.lastSeq ?? parent?.sourceRefs?.at?.(-1)?.seq ?? firstSeq)
  const base = `⟦${pointerId}⟧ [${firstSeq}-${lastSeq}]`
  if (mode === 'id-only') return { mode, pointerId, label: '', text: base, estimatedTokens: estimateTokens(base) }
  let label = mode === 'compact'
    ? compactLabelForPointer(parent, { maxCharacters: Math.min(maxLabelCharacters, 12) })
    : labelForPointer(parent, { maxCharacters: maxLabelCharacters })
  let text = `${base} ${label}`.trim()
  while (label.length > 0 && estimateTokens(text) > maxTokens) {
    label = [...label].slice(0, -1).join('').trim()
    text = `${base} ${label}`.trim()
  }
  if (estimateTokens(text) > maxTokens) return { mode: 'id-only', pointerId, label: '', text: base, estimatedTokens: estimateTokens(base) }
  return { mode, pointerId, label, text, estimatedTokens: estimateTokens(text) }
}
