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
    text: '本环境使用 Chunk-only Vector Memory：工作消息按结构切成可追溯 context chunk，每个卸载 chunk 只有一份权威正文和一个向量编码。低活性 chunk 留在当前会话感知层，高价值 chunk 进入工作区半持久投影与记忆库。被动目录曝光不算关联。可用 sensory_recall/open/store/demote/status、memory_layer_status、memory_bank_open、memory_forget；调试工具可输出完整 prompt、chunk、vector 与分层属性。',
  }), 'sensory-memory: chunk context')
  ctx.effect(() => async () => {
    const drained = await maintenance.drain(null, { timeoutMs: config.shutdownDrainTimeoutMs ?? 30_000 })
    if (!drained.ok) ctx.logger?.warn?.('[sensory-memory] shutdown drain incomplete: %s', JSON.stringify(drained))
  }, 'sensory-memory: maintenance drain')
}
