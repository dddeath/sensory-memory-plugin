import { renderParentPointer } from './pointer-label-compressor.js'

function associationWeight(parent) {
  return (parent?.associations ?? []).reduce((sum, item) => sum + Math.max(0, Number(item?.weight ?? 0)), 0)
}

function surfaceValue(parent, newestSeq) {
  const recency = newestSeq > 0 ? Math.max(0, Number(parent?.lastSeq ?? 0)) / newestSeq : 0
  return (parent?.pinned || parent?.openTask ? 10 : 0)
    + Math.min(3, associationWeight(parent))
    + Math.max(0, Number(parent?.evidenceQuality ?? 0))
    + recency
}

function pointerTokens(parent) {
  const recorded = Number(parent?.pointer?.contentTokens ?? parent?.pointer?.estimatedTokens)
  if (Number.isFinite(recorded) && recorded >= 0) return recorded
  const mode = parent?.surfaceResidency === 'id-pointer' ? 'id-only'
    : parent?.surfaceResidency === 'compact-pointer' ? 'compact' : 'labeled'
  return renderParentPointer(parent, { mode, maxTokens: mode === 'compact' ? 12 : 24 }).estimatedTokens
}

export class SurfaceBudgetController {
  constructor(config = {}) {
    this.config = {
      labeledMaxTokens: Math.max(8, Number(config.pointerMaxTokens ?? 24)),
      compactMaxTokens: Math.max(4, Number(config.compactPointerMaxTokens ?? 12)),
    }
  }

  plan(parents, { budgetTokens = Infinity } = {}) {
    const visible = (parents ?? []).filter((parent) => ['labeled-pointer', 'compact-pointer', 'id-pointer'].includes(parent.surfaceResidency))
    const newestSeq = Math.max(0, ...visible.map((parent) => Number(parent.lastSeq ?? 0)))
    const ordered = visible.map((parent) => ({ parent, value: surfaceValue(parent, newestSeq) }))
      .sort((left, right) => left.value - right.value || Number(left.parent.firstSeq) - Number(right.parent.firstSeq))
    let totalTokens = visible.reduce((sum, parent) => sum + pointerTokens(parent), 0)
    const initialTokens = totalTokens
    const actions = []
    const apply = (row, mode, surfaceResidency, maxTokens) => {
      const current = pointerTokens(row.parent)
      const rendered = mode === 'none'
        ? { mode, pointerId: row.parent.pointer?.pointerId ?? null, label: '', text: '', estimatedTokens: 0 }
        : renderParentPointer(row.parent, { mode, maxTokens, maxLabelCharacters: mode === 'compact' ? 12 : 32 })
      if (rendered.estimatedTokens >= current) return
      actions.push({
        parentId: row.parent.id,
        from: row.parent.surfaceResidency,
        to: surfaceResidency,
        mode,
        rendered,
        savedTokens: current - rendered.estimatedTokens,
        value: row.value,
      })
      totalTokens -= current - rendered.estimatedTokens
      row.parent = {
        ...row.parent,
        surfaceResidency,
        pointer: { ...(row.parent.pointer ?? {}), ...rendered, contentTokens: rendered.estimatedTokens },
      }
    }
    for (const row of ordered) {
      if (totalTokens <= budgetTokens) break
      if (row.parent.surfaceResidency === 'labeled-pointer') apply(row, 'compact', 'compact-pointer', this.config.compactMaxTokens)
    }
    for (const row of ordered) {
      if (totalTokens <= budgetTokens) break
      if (row.parent.surfaceResidency !== 'id-pointer') apply(row, 'id-only', 'id-pointer', this.config.compactMaxTokens)
    }
    for (const row of ordered) {
      if (totalTokens <= budgetTokens) break
      if (row.parent.pinned || row.parent.openTask || row.parent.surfaceResidency !== 'id-pointer') continue
      apply(row, 'none', 'detached', 0)
    }
    return {
      budgetTokens: Math.max(0, Number(budgetTokens)),
      initialTokens,
      finalTokens: totalTokens,
      targetReached: totalTokens <= budgetTokens,
      actions,
      counts: {
        visible: visible.length,
        compact: actions.filter((item) => item.to === 'compact-pointer').length,
        idOnly: actions.filter((item) => item.to === 'id-pointer').length,
        detached: actions.filter((item) => item.to === 'detached').length,
      },
    }
  }

  status() { return { ...this.config } }
}
