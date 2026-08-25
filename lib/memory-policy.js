const EXPLICIT_REMEMBER = /^(?:请|麻烦|务必|请你)?\s*(?:帮我)?\s*(?:记住|记下|记牢|保存|长期记住)\s*[：:,，]?\s*(.+)$/isu
const EXPLICIT_GLOBAL = /(?:全局|跨工作区|所有项目|所有工作区|global|cross[- ]workspace)/iu
const NEGATED = /(?:不要|别|无需|不用|不必|并非|不是要|not\s+to|do\s+not)\s*(?:记住|记下|保存)/iu
const META_OR_QUOTED = /(?:例如|示例|假设|如果用户说|这句话|提示词|正则|测试“?记住|quote|example)/iu

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

export function activationOf(associations = [], { now = Date.now(), currentTurn = 0 } = {}) {
  let total = 0
  for (const use of associations) {
    const weight = Math.max(0, finite(use.weight, 0))
    if (weight === 0) continue
    const turnDistance = Math.max(0, Number(currentTurn) - finite(use.turn, currentTurn))
    const hourDistance = Math.max(0, (now - finite(use.at, now)) / 3_600_000)
    total += weight * ((1 + turnDistance) ** -0.5) * (2 ** (-hourDistance / 24))
  }
  return total > 0 ? Math.log(total) : Number.NEGATIVE_INFINITY
}

export function addAssociation(record, association) {
  const associations = [...(record?.associations ?? [])]
  const itemId = String(record?.segmentId ?? record?.id ?? association?.itemId ?? '')
  const turn = Number(association?.turn)
  if (!Number.isFinite(turn)) throw new TypeError('association.turn is required')
  const sessionId = String(association.sessionId ?? record?.sessionId ?? '')
  if (associations.some((item) => Number(item.turn) === turn
    && String(item.sessionId ?? '') === sessionId
    && String(item.itemId ?? itemId) === itemId)) {
    return { ...record, associations, associationDeduplicated: true }
  }
  associations.push({
    itemId,
    sessionId,
    workspaceId: String(association.workspaceId ?? record?.workspaceId ?? ''),
    turn,
    ...(Number.isFinite(Number(association.workspaceTurn)) ? { workspaceTurn: Number(association.workspaceTurn) } : {}),
    at: finite(association.at, Date.now()),
    kind: String(association.kind ?? 'verified-answer-use'),
    weight: Math.max(0, finite(association.weight, 0)),
    verified: association.verified !== false,
  })
  return { ...record, associations, associationDeduplicated: false, updatedAt: Date.now() }
}

export function parseRememberDirective(text) {
  const input = String(text ?? '').trim()
  if (!input || NEGATED.test(input) || META_OR_QUOTED.test(input)) return null
  const match = input.match(EXPLICIT_REMEMBER)
  const content = match?.[1]?.trim()
    .replace(/^(?:(?:全局|跨工作区|所有项目|所有工作区|global|cross[- ]workspace)\s*)+[：:,，]\s*/iu, '')
  if (!content || content.length < 2) return null
  return {
    content,
    scopeKind: EXPLICIT_GLOBAL.test(input) ? 'user-global' : 'workspace',
    explicit: true,
  }
}

export function isCanonicalEvidence(record, trustedEvidenceTools = []) {
  if (!record) return false
  if (record.role === 'user' && record.sourceKind === 'user') return true
  if (record.role === 'tool') return trustedEvidenceTools.includes(String(record.toolName ?? ''))
  if (record.role === 'assistant') return Boolean(record.verifiedFromUser || record.verifiedFromTrustedTool)
  return false
}

export function isStableBankType(value) {
  return ['preference', 'commitment', 'decision', 'verified-fact', 'workflow', 'project-constraint']
    .includes(String(value ?? ''))
}

export class MemoryPolicy {
  constructor(config = {}) {
    this.config = {
      workingInactiveTurns: Math.max(1, config.workingInactiveTurns ?? 4),
      semiAssociationTurns: Math.max(1, config.semiAssociationTurns ?? 8),
      semiAssociationCount: Math.max(1, config.semiAssociationCount ?? 2),
      bankAssociationCount: Math.max(1, config.bankAssociationCount ?? 3),
      bankSessionCount: Math.max(1, config.bankSessionCount ?? 2),
      semiInactiveWorkspaceTurns: Math.max(1, config.semiInactiveWorkspaceTurns ?? 12),
      semiInactiveHours: Math.max(1, config.semiInactiveHours ?? 24),
      semiActivationFloor: finite(config.semiActivationFloor, -1.5),
      semiImportance: finite(config.semiImportance, 0.85),
      semiDurability: finite(config.semiDurability, 0.85),
      bankImportance: finite(config.bankImportance, 0.90),
      bankDurability: finite(config.bankDurability, 0.90),
      evidenceQuality: finite(config.evidenceQualityThreshold, 0.80),
    }
  }

  activation(record, state = {}) { return activationOf(record?.associations, state) }

  strongAssociations(record, { currentTurn = Infinity, windowTurns = Infinity } = {}) {
    return (record?.associations ?? []).filter((use) => use.verified !== false
      && Number(use.weight) > 0
      && (currentTurn - Number(use.turn)) <= windowTurns)
  }

  shouldMoveWorkingToSensory(segment, { currentTurn, contextPressure = false } = {}) {
    if (!segment?.sealedAt || segment.openTask || segment.pinned) return false
    return contextPressure === true
  }

  compressionPriority(segment, { currentTurn } = {}) {
    const last = this.strongAssociations(segment).sort((a, b) => b.turn - a.turn)[0]?.turn ?? segment?.turn ?? currentTurn
    const inactiveTurns = Math.max(0, Number(currentTurn) - Number(last))
    const estimatedTokens = Math.max(0, Number(segment?.estimatedTokens ?? 0))
    return {
      eligible: Boolean(segment?.sealedAt) && !segment?.openTask && !segment?.pinned,
      inactiveTurns,
      cold: inactiveTurns >= this.config.workingInactiveTurns,
      estimatedTokens,
    }
  }

  shouldPromoteToSemi(record, { currentTurn } = {}) {
    if (!record?.verifiedSource || Number(record.evidenceQuality ?? 0) < this.config.evidenceQuality) return false
    if (Number(record.durability ?? 0) < this.config.semiDurability) return false
    const recent = this.strongAssociations(record, { currentTurn, windowTurns: this.config.semiAssociationTurns })
    return recent.length >= this.config.semiAssociationCount
      || Number(record.importance ?? 0) >= this.config.semiImportance
  }

  shouldPromoteToBank(record, { currentTurn } = {}) {
    if (!record?.verifiedSource || !isStableBankType(record.memoryType)) return false
    const strong = this.strongAssociations(record, { currentTurn })
    const sessions = new Set(strong.map((item) => item.sessionId).filter(Boolean))
    return (strong.length >= this.config.bankAssociationCount && sessions.size >= this.config.bankSessionCount)
      || (Number(record.importance ?? 0) >= this.config.bankImportance
        && Number(record.durability ?? 0) >= this.config.bankDurability
        && record.bankReviewApproved === true)
  }

  shouldExpireSemi(record, { currentWorkspaceTurn, now = Date.now() } = {}) {
    if (record?.pinned || record?.openTask) return false
    const strong = this.strongAssociations(record)
    const last = strong.sort((a, b) => b.at - a.at)[0]
    const lastTurn = last?.workspaceTurn ?? record?.promotedWorkspaceTurn ?? 0
    const lastAt = last?.at ?? record?.promotedAt ?? record?.updatedAt ?? now
    const inactiveTurns = Number(currentWorkspaceTurn) - Number(lastTurn)
    const inactiveHours = (now - Number(lastAt)) / 3_600_000
    const activation = this.activation(record, { currentTurn: currentWorkspaceTurn, now })
    return (inactiveTurns >= this.config.semiInactiveWorkspaceTurns
      || inactiveHours >= this.config.semiInactiveHours)
      && activation < this.config.semiActivationFloor
  }
}
