import { registerSensoryTools } from './sensory-tools.js'

export function installChunkMemory(ctx, config, services) {
  const { runtime, debug, auxiliaryRequests, maintenance } = services
  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next))
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
    text: '本环境使用 Parent/Child Vector Memory：Parent 是唯一权威上下文记录，Child 仅提供细粒度 E5 向量定位；检索按子问题聚合并返回完整 Parent current view。低活性 Parent 留在当前会话感知层，高价值 Parent 进入工作区半持久投影与记忆库。被动候选与目录曝光不算关联。可用 sensory_recall/open/store/demote/status、memory_layer_status、memory_bank_open、memory_forget；调试工具可输出 Parent/Child、coverage、来源与完整 prompt。',
  }), 'sensory-memory: parent child context')
  ctx.effect(() => async () => {
    const drained = await maintenance.drain(null, { timeoutMs: config.shutdownDrainTimeoutMs ?? 30_000 })
    if (!drained.ok) ctx.logger?.warn?.('[sensory-memory] shutdown drain incomplete: %s', JSON.stringify(drained))
  }, 'sensory-memory: maintenance drain')
}
