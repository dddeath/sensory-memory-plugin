import { parseLlmJson } from './stage4-llm.js'

function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[\s，。；;：:、“”'"`]/g, '')
}

function sourceText(value) {
  if (typeof value === 'string') return value
  if (typeof value?.text === 'string') return value.text
  if (Array.isArray(value?.content)) {
    return value.content.map((block) => block?.text ?? '').filter(Boolean).join(' ')
  }
  return value ? JSON.stringify(value) : ''
}

function finding(value, fallbackType) {
  if (typeof value === 'string') return { type: fallbackType, detail: value }
  return value && typeof value === 'object' ? { type: fallbackType, ...value } : null
}

function findings(parsed, key) {
  const value = parsed?.[key]
  if (Array.isArray(value)) return value.map((item) => finding(item, key)).filter(Boolean)
  if (Number.isFinite(value)) {
    return Array.from({ length: Math.max(0, Math.floor(value)) }, (_, index) => ({ type: key, detail: `${key}-${index + 1}` }))
  }
  return []
}

function observationKeyValue(text) {
  const match = String(text ?? '').match(/^(.{1,60}?)(?:是|=|:|：)([^，。；;\r\n]+)$/)
  return match ? { key: normalize(match[1]), value: normalize(match[2]) } : null
}

function explicitFacts(text) {
  const facts = []
  const pattern = /((?:客户#\d+|项目[A-Z])[^，。；;\r\n]{0,30}?(?:是|=|:|：)[^，。；;\r\n]+)/g
  for (const match of String(text ?? '').matchAll(pattern)) facts.push(match[1].trim())
  return facts
}

export class HaluMemAuditor {
  constructor({ index, llm, config = {} }) {
    this.index = index
    this.llm = llm
    this.config = {
      pollutionThreshold: config.pollutionThreshold ?? 0.2,
      checkEvery: config.checkEvery ?? 200,
      sampleSize: config.auditSampleSize ?? 20,
    }
    this.circuitBroken = false
    this.lastAudit = null
    this.stats = { audits: 0, llmCalls: 0, llmFailures: 0, totalDurationMs: 0 }
  }

  #sample(size, scopeId = null) {
    const all = this.index.all(scopeId)
    const count = Math.max(0, Math.min(all.length, Math.floor(size)))
    if (count === 0) return []
    const stride = all.length / count
    return Array.from({ length: count }, (_, index) => all[Math.floor(index * stride)])
  }

  #deterministicAudit(sample) {
    const insertion = []
    const contradiction = []
    const deletion = []
    for (const entity of sample) {
      const sources = (entity.source_refs ?? [])
        .map((sourceRef) => ({ sourceRef, text: sourceText(this.index.readSource(sourceRef)) }))
        .filter((item) => item.text)
      const sourceMaterial = normalize(sources.map((item) => item.text).join(' '))
      for (const observation of entity.observations ?? []) {
        if (sourceMaterial && !sourceMaterial.includes(normalize(observation))) {
          insertion.push({ entity: entity.name, observation, source_refs: entity.source_refs ?? [] })
        }
      }
      const values = new Map()
      for (const observation of entity.observations ?? []) {
        const parsed = observationKeyValue(observation)
        if (!parsed) continue
        let set = values.get(parsed.key)
        if (!set) values.set(parsed.key, set = new Set())
        set.add(parsed.value)
      }
      for (const [key, set] of values) {
        if (set.size > 1) contradiction.push({ entity: entity.name, key, values: [...set] })
      }
      for (const item of sources) {
        for (const fact of explicitFacts(item.text)) {
          const normalizedFact = normalize(fact)
          const remembered = (entity.observations ?? []).some((observation) => (
            normalize(observation).includes(normalizedFact) || normalizedFact.includes(normalize(observation))
          ))
          if (!remembered) deletion.push({ entity: entity.name, fact, sourceRef: item.sourceRef })
        }
      }
    }
    return { insertion, contradiction, deletion }
  }

  async audit(sampleSize = this.config.sampleSize, scopeId = null) {
    const started = performance.now()
    const sample = this.#sample(sampleSize, scopeId)
    const deterministic = this.#deterministicAudit(sample)
    let llmResult = { insertion: [], contradiction: [], deletion: [] }
    if (this.llm && sample.length > 0) {
      const payload = sample.map((entity) => ({
        entity: entity.name,
        observations: (entity.observations ?? []).slice(0, 5),
        sources: (entity.source_refs ?? []).slice(0, 2).map((sourceRef) => ({
          sourceRef,
          text: sourceText(this.index.readSource(sourceRef)).slice(0, 500),
        })),
      }))
      const prompt = `审计记忆并只返回JSON：{"insertion":[],"contradiction":[],"deletion":[]}。insertion=原文无此事实，contradiction=同一事实冲突，deletion=原文明示但索引遗漏。样本：${JSON.stringify(payload)}`
      try {
        this.stats.llmCalls += 1
        const parsed = parseLlmJson(await this.llm.complete(prompt, {
          system: '你是HaluMem质量审计器。只输出紧凑JSON。',
          maxTokens: 768,
          purpose: 'memory-audit',
          sessionId: scopeId && scopeId !== 'global' ? scopeId : undefined,
        }))
        llmResult = {
          insertion: findings(parsed, 'insertion'),
          contradiction: findings(parsed, 'contradiction'),
          deletion: findings(parsed, 'deletion'),
        }
      } catch {
        this.stats.llmFailures += 1
      }
    }
    const combined = {
      insertion: [...deterministic.insertion, ...llmResult.insertion],
      contradiction: [...deterministic.contradiction, ...llmResult.contradiction],
      deletion: [...deterministic.deletion, ...llmResult.deletion],
    }
    const polluted = new Set()
    for (const [type, entries] of Object.entries(combined)) {
      entries.forEach((entry, index) => polluted.add(entry.entity ?? `${type}:${index}`))
    }
    const pollutionRate = sample.length === 0 ? 0 : Math.min(1, polluted.size / sample.length)
    const result = {
      ...combined,
      pollutionRate,
      sampleSize: sample.length,
      auditedAt: Date.now(),
      scopeId,
    }
    this.lastAudit = result
    this.stats.audits += 1
    this.stats.totalDurationMs += performance.now() - started
    return result
  }

  async maybeCircuitBreak(report = this.lastAudit) {
    const audit = report ?? await this.audit()
    if (audit.pollutionRate > this.config.pollutionThreshold) {
      this.circuitBroken = true
      const reason = `pollutionRate ${audit.pollutionRate.toFixed(4)} > ${this.config.pollutionThreshold}`
      this.index.setWriteMode?.('propose', reason, audit.scopeId ?? 'global')
      return { circuitBroken: true, reason, scopeId: audit.scopeId ?? 'global', writeMode: 'propose' }
    }
    return { circuitBroken: this.circuitBroken, reason: null, scopeId: audit.scopeId ?? 'global', writeMode: this.index.writeModeFor?.(audit.scopeId ?? 'global') ?? this.index.writeMode ?? 'direct' }
  }

  status() {
    return {
      circuitBroken: this.circuitBroken,
      threshold: this.config.pollutionThreshold,
      lastAudit: this.lastAudit,
      stats: { ...this.stats },
      writeMode: this.index.writeMode ?? 'direct',
    }
  }
}
