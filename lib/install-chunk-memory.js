import { registerSensoryTools } from './sensory-tools.js'

export function installChunkMemory(ctx, config, services) {
  const { runtime, debug, auxiliaryRequests, maintenance } = services
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
    text: '本环境使用压力驱动的 Parent/Child 上下文压缩：低于上下文阈值时保留原始工作消息，不自动召回；达到阈值后才把冷 Parent 无损卸载到当前会话索引，Child 仅提供 E5 定位，后续只按需展开已卸载 Parent。DSH 原生 compaction 保留为安全兜底。可用 sensory_recall/open/store/demote/status、memory_layer_status、memory_bank_open、memory_forget；调试工具可输出压力、Parent/Child、来源与完整 prompt。',
  }), 'sensory-memory: parent child context')
  ctx.effect(() => async () => {
    const drained = await maintenance.drain(null, { timeoutMs: config.shutdownDrainTimeoutMs ?? 30_000 })
    if (!drained.ok) ctx.logger?.warn?.('[sensory-memory] shutdown drain incomplete: %s', JSON.stringify(drained))
  }, 'sensory-memory: maintenance drain')
}
