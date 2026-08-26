export class SensoryMaintenance {
  constructor({ runtime }) {
    if (!runtime) throw new TypeError('chunk runtime is required')
    this.runtime = runtime
    this.stats = { drains: 0, finalized: 0, dropped: 0, timeouts: 0 }
  }

  async drain(sessionId = null, { timeoutMs = 30_000 } = {}) {
    const started = performance.now()
    const ledger = await this.runtime.ledger.drain(sessionId ? `session:${sessionId}` : null, timeoutMs)
    const vectorRepair = ledger.timeout ? null : await this.runtime.repairPendingVectors(sessionId)
    this.runtime.ledger.flush()
    if (ledger.timeout) this.stats.timeouts += 1
    else this.stats.drains += 1
    return { ok: ledger.ok !== false && vectorRepair?.ok !== false, timeout: Boolean(ledger.timeout), sessionId, ledger, vectorRepair, durationMs: performance.now() - started }
  }

  async finalizeSession(sessionId) {
    const result = await this.runtime.finalizeSession(sessionId)
    this.stats.finalized += 1
    return result
  }

  async dropScope(sessionId, { workspaceId = null, dropUniqueWorkspaceMemory = false } = {}) {
    const effectiveWorkspaceId = workspaceId ?? this.runtime.sessionState(sessionId).workspaceId
    const result = await this.runtime.dropSession(sessionId, { workspaceId: effectiveWorkspaceId, dropUniqueWorkspaceMemory })
    this.stats.dropped += 1
    return result
  }

  status(sessionId = null) {
    return {
      ...this.stats,
      architecture: 'parent-child-vector-v2',
      indexScope: 'session',
      layered: sessionId ? this.runtime.status(sessionId) : null,
    }
  }
}
