import { registerSensoryTools } from './sensory-tools.js'

export function installChunkMemory(ctx, config, services) {
  const { runtime, debug, auxiliaryRequests, maintenance, toolMode = 'full', retrievalToolCallLimit = null } = services
  const contextText = toolMode === 'compression-only'
    ? '本环境只评测压力驱动的 Parent/Child 上下文压缩：低于上下文阈值时保留原始工作消息；达到阈值后把冷 Parent 卸载到当前会话索引并以检查点替换。当前评测关闭记忆检索和展开工具，DSH 原生 compaction 保留为安全兜底。'
    : toolMode === 'retrieval-only'
      ? `本环境使用压力驱动的 Parent/Child 上下文压缩：低于上下文阈值时保留原始工作消息，不自动召回；达到阈值后才把冷 Parent 无损卸载到当前会话索引。出现 sensory-retrieval-hint 时先调用一次 sensory_recall；recall 的 matchedChildren 已直接披露命中证据，证据够用就作答，缺少相邻上下文时才调用 sensory_open。计数或汇总问题先枚举所有来源明确且仍待完成的独立对象或动作，再求和；不要仅因地点或类别措辞近义而丢弃证据。工具返回 converged 或 budgetExceeded 后立即根据已有证据作答。${retrievalToolCallLimit ? `每题最多调用 sensory_recall ${retrievalToolCallLimit} 次、sensory_open ${retrievalToolCallLimit} 次。` : ''}`
      : '本环境使用压力驱动的 Parent/Child 上下文压缩：低于上下文阈值时保留原始工作消息，不自动召回；达到阈值后才把冷 Parent 无损卸载到当前会话索引。出现 sensory-retrieval-hint 时先调用 sensory_recall；recall 直接披露 matchedChildren，缺少相邻上下文时才调用 sensory_open。计数或汇总问题先枚举所有来源明确且仍待完成的独立对象或动作，再求和；不要仅因地点或类别措辞近义而丢弃证据。工具报告收敛后立即作答。DSH 原生 compaction 保留为安全兜底。可用 sensory_recall/open/store/demote/status、memory_layer_status、memory_bank_open、memory_forget；调试工具可输出压力、Parent/Child、来源与完整 prompt。'
  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next), { prepend: true })
  ctx.on('agent/turn-stopping', (payload) => {
    const pending = runtime.turnStopping(payload)
    if (pending?.catch) void pending.catch((error) => ctx.logger?.warn?.('[sensory-memory] chunk turn-stopping failed: %s', String(error)))
  })
  ctx.on('session/disposed', (session) => {
    void runtime.drainSession(session.id).catch((error) => ctx.logger?.warn?.('[sensory-memory] session drain failed: %s', String(error)))
  })
  ctx.on('llm/stream', (options, next) => {
    const auxiliary = Boolean(auxiliaryRequests.has(options))
    try { debug.captureRequest(options, { auxiliary }) } catch (error) { ctx.logger?.warn?.('[sensory-memory] prompt debug capture failed: %s', String(error)) }
    return next()
  })
  ctx.effect(() => registerSensoryTools(ctx, services), 'sensory-memory: tools')
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'sensory:relay',
    order: -85,
    text: contextText,
  }), 'sensory-memory: parent child context')
  ctx.effect(() => async () => {
    const drained = await maintenance.drain(null, { timeoutMs: config.shutdownDrainTimeoutMs ?? 30_000 })
    if (!drained.ok) ctx.logger?.warn?.('[sensory-memory] shutdown drain incomplete: %s', JSON.stringify(drained))
  }, 'sensory-memory: maintenance drain')
}
