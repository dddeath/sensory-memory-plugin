import { parseLlmJson } from './stage4-llm.js'

const CUES = /(?:(?:是否|要不要|该不该|需不需要).{0,16}(?:记住|记下|保存)|(?:should|do\s+we|maybe).{0,24}remember)/iu
const BANK_TYPES = new Set(['preference', 'commitment', 'decision', 'verified-fact', 'workflow', 'project-constraint'])

function clamp(value, fallback = 0.5) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback
}

function normalize(value, segment) {
  const action = ['none', 'sensory', 'semipersistent', 'bank'].includes(value?.action) ? value.action : 'none'
  const scopeKind = value?.scopeKind === 'user-global' ? 'user-global' : 'workspace'
  const memoryType = BANK_TYPES.has(value?.memoryType) ? value.memoryType : segment.memoryType
  return {
    action,
    scopeKind,
    memoryType,
    content: String(value?.content ?? segment.userText ?? '').trim().slice(0, 2000),
    importance: clamp(value?.importance),
    durability: clamp(value?.durability),
    evidenceQuality: Math.min(clamp(value?.evidenceQuality), Number(segment.evidenceQuality ?? 0)),
    boundaryReason: String(value?.boundaryReason ?? segment.boundaryReason ?? 'turn-complete').slice(0, 80),
    confidence: clamp(value?.confidence, 0),
  }
}

export class MemoryTransitionReviewer {
  constructor({ llm, config = {} } = {}) {
    this.llm = llm
    this.enabled = config.memoryTransitionReviewEnabled !== false && Boolean(llm)
    this.stats = { attempts: 0, llmCalls: 0, approved: 0, rejected: 0, failures: 0, byPurpose: { 'memory-transition-review': 0 } }
  }

  shouldReview(segment) {
    return this.enabled && Boolean(segment?.verifiedSource) && CUES.test(String(segment?.userText ?? ''))
  }

  async review(segment) {
    if (!this.shouldReview(segment)) return null
    this.stats.attempts += 1
    this.stats.llmCalls += 1
    this.stats.byPurpose['memory-transition-review'] += 1
    try {
      const prompt = `Review one memory transition. Return one JSON object only: {action:none|sensory|semipersistent|bank,scopeKind:workspace|user-global,memoryType:preference|commitment|decision|verified-fact|workflow|project-constraint,content,importance,durability,evidenceQuality,boundaryReason,confidence}. Do not invent facts. Bank requires stable durable evidence. User-global requires explicit cross-workspace wording.\nUser evidence:${segment.userText}`
      const output = await this.llm.complete(prompt, {
        system: 'You are a conservative memory transition reviewer. Use only the supplied user evidence.',
        maxTokens: 320,
        purpose: 'memory-transition-review',
        sessionId: segment.sessionId,
      })
      const decision = normalize(parseLlmJson(output), segment)
      if (decision.confidence < 0.8 || (decision.action === 'bank' && !segment.verifiedSource)) decision.action = 'none'
      if (decision.action === 'none') this.stats.rejected += 1
      else this.stats.approved += 1
      return decision
    } catch (error) {
      this.stats.failures += 1
      return { action: 'none', confidence: 0, error: String(error) }
    }
  }

  status() { return { ...this.stats, enabled: this.enabled } }
}
