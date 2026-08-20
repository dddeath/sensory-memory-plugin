import { randomUUID } from 'node:crypto'

import { extractQuery, protectToolPairBoundary } from './injection-engine.js'
import { registerSensoryTools } from './sensory-tools.js'

function turnKey({ agent, turn, step }) {
  return `${agent?.session?.id ?? 'session'}:${turn ?? 0}:${step ?? 0}`
}

function scopeFor(config, agent) {
  return config.indexScope === 'session' ? String(agent?.session?.id ?? 'global') : 'global'
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (Array.isArray(message?.content)) return message.content.map((block) => block?.text ?? '').filter(Boolean).join(' ')
  return String(message?.text ?? '')
}

function snapshotMessage(catalog, sessionId, turn, step) {
  return {
    id: `sensory_catalog_${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text: catalog }],
    source: {
      kind: 'plugin',
      plugin: '@local/sensory-memory',
      sourcePlugin: '@local/sensory-memory',
      purpose: 'sensory-catalog',
      sessionId: String(sessionId ?? ''),
      turn,
      step,
    },
  }
}

function previousCatalog(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind === 'plugin' && message?.source?.purpose === 'sensory-catalog') return textOf(message)
    if (message?.role === 'user' && message?.source?.kind !== 'plugin') break
  }
  return null
}

function insertSnapshot(decision, claimed, snapshot) {
  if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return null
  let proposedIndex = decision.messages.findIndex((message) => claimed.includes(message))
  if (proposedIndex < 0) proposedIndex = Math.max(0, decision.messages.length - 1)
  const insertIndex = protectToolPairBoundary(decision.messages, proposedIndex)
  return {
    decision: { ...decision, messages: decision.messages.toSpliced(insertIndex, 0, snapshot) },
    proposedIndex,
    insertIndex,
    toolBoundaryAdjusted: insertIndex !== proposedIndex,
  }
}

export function installStage3(ctx, config, services) {
  const { injector, rewriter = null, debug = null, auxiliaryRequests = null } = services

  ctx.on('agent/pre-step', async (payload = {}, next) => {
    const decision = await next()
    const { agent, messages: claimed = [], turn, step, signal } = payload
    if (decision?.kind !== 'enter' || config.enabled === false || !agent?.session) return decision
    try {
      signal?.throwIfAborted?.()
      injector.setSession(agent.session)
      const history = agent.session.deriveMessages?.() ?? []
      const queryMessages = [...history, ...claimed]
      const query = extractQuery({ messages: queryMessages })
      if (!query) return decision
      const scopeId = scopeFor(config, agent)
      const viewer = {
        cwd: agent.cwd,
        sessionId: agent.session.id,
        scopeId,
        messages: queryMessages,
        turnKey: turnKey(payload),
      }
      let catalog = injector.matchAndRenderSync(query, viewer)
      let fallback = null
      if (!catalog && rewriter?.enabled) {
        fallback = await rewriter.maybeRewrite(query, viewer)
        if (fallback?.hits?.length) {
          catalog = injector.renderCatalog(fallback.hits)
          injector.lastResult = {
            queryText: query,
            rewrittenQuery: fallback.rewrittenQuery,
            fallback: true,
            fromRewriteCache: fallback.fromCache,
            hits: injector.lastRender?.hits ?? fallback.hits,
            entrySeqs: fallback.entrySeqs ?? [],
            catalog,
            durationMs: rewriter.stats?.totalDurationMs ?? 0,
          }
        }
      }
      if (!catalog) {
        injector.lastInjection = { kind: 'snapshot', inserted: false, reason: 'no-hit', scopeId, turn, step }
        return decision
      }
      if (previousCatalog(history) === catalog) {
        injector.lastInjection = { kind: 'snapshot', inserted: false, reason: 'deduplicated', scopeId, turn, step }
        return decision
      }
      const snapshot = snapshotMessage(catalog, agent.session.id, turn, step)
      const inserted = insertSnapshot(decision, claimed, snapshot)
      if (!inserted) return decision
      injector.lastInjection = {
        kind: 'snapshot',
        inserted: true,
        role: 'user',
        sourceKind: 'plugin',
        scopeId,
        turn,
        step,
        fallback: Boolean(fallback),
        proposedIndex: inserted.proposedIndex,
        insertIndex: inserted.insertIndex,
        beforeLength: decision.messages.length,
        afterLength: inserted.decision.messages.length,
        toolBoundaryAdjusted: inserted.toolBoundaryAdjusted,
      }
      ctx.logger?.info?.(
        '[sensory-memory] pre-step catalog hits=%d index=%d scope=%s fallback=%s durationMs=%d',
        injector.lastResult?.hits?.length ?? 0,
        inserted.insertIndex,
        scopeId,
        String(Boolean(fallback)),
        injector.lastResult?.durationMs ?? -1,
      )
      return inserted.decision
    } catch (error) {
      ctx.logger?.warn?.('[sensory-memory] pre-step injection failed: %s', String(error))
      return decision
    }
  })

  // Requests are deep-frozen by DSH. This hook deliberately observes only;
  // model-visible catalog messages are returned from agent/pre-step above.
  ctx.on('llm/stream', (options, next) => {
    const auxiliary = Boolean(auxiliaryRequests?.has?.(options))
    injector.lastObservedRequest = {
      sessionId: options?.sessionId ?? null,
      messageCount: Array.isArray(options?.messages) ? options.messages.length : 0,
      frozen: Object.isFrozen(options) || Object.isFrozen(options?.messages),
      requestKind: auxiliary ? 'auxiliary' : 'main',
      observedAt: Date.now(),
    }
    try {
      debug?.captureRequest?.(options, { auxiliary })
    } catch (error) {
      ctx.logger?.warn?.('[sensory-memory] prompt debug capture failed: %s', String(error))
    }
    return next()
  })

  ctx.effect(() => registerSensoryTools(ctx, services), 'sensory-memory: tools')
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'sensory:relay',
    order: -85,
    text: '本环境有感知记忆：每个模型step前以user/plugin快照注入相关目录；[cache]为高频半持久入口。看到 [[实体]] 后可用 sensory_open/recall 展开。用户要求调试时，显式调用 sensory_debug_last_prompt、sensory_debug_cache_prompt、sensory_debug_index_prompt 或 sensory_debug_working_prompt，并按 output=conversation|document|both 输出；清理当前索引需调用 sensory_clear_workspace_index 且 confirm=true。',
  }), 'sensory-memory: context')
}

export const stage3Internals = { insertSnapshot, previousCatalog, snapshotMessage }
