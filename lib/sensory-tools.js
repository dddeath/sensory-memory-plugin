import { SENSORY_DEBUG_OUTPUT_MODES } from './sensory-debug.js'

const TEXT_OUTPUT = Object.freeze({
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
})

export function defineTool(options) {
  const properties = {}
  const required = []
  for (const [name, definition] of Object.entries(options.parameters ?? {})) {
    const { required: isRequired, ...schema } = definition
    properties[name] = schema
    if (isRequired) required.push(name)
  }
  return {
    ...options,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: options.output ?? TEXT_OUTPUT,
  }
}

function cleanEntityName(value) {
  return String(value ?? '').trim().replace(/^\[\[/, '').replace(/\]\]$/, '')
}

function executionSource(exec, scopeId = 'global') {
  const session = exec?.agent?.session
  const events = Array.isArray(session?.events) ? session.events : []
  const latest = events.at(-1)
  return {
    sessionId: String(session?.id ?? 'sensory-tool'),
    seq: Number.isFinite(latest?.seq) ? latest.seq : Date.now(),
    scopeId,
  }
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function debugOutputParameters() {
  return {
    output: {
      type: 'string',
      enum: [...SENSORY_DEBUG_OUTPUT_MODES],
      default: 'conversation',
      description: '输出到当前对话、当前工作区文档，或两者同时输出',
    },
    documentPath: {
      type: 'string',
      description: '可选的工作区内 .md/.json 路径；省略时写入 results/sensory-debug/',
    },
  }
}

export function createSensoryToolDefinitions({
  index,
  matcher,
  extractor,
  sourceStore,
  demoter,
  injector = null,
  auditor = null,
  cache = null,
  llmExtractor = null,
  rewriter = null,
  llmClient = null,
  debug = null,
  runtime = null,
  ledger = null,
  semipersistentLayer = null,
  bank = null,
}) {
  const scopeForExec = (exec = {}) => runtime
    ? String(exec?.agent?.session?.id ?? '')
    : matcher.scopeFor?.({
    sessionId: exec?.agent?.session?.id,
    scopeId: exec?.scopeId,
  }) ?? 'global'
  const recall = defineTool({
    name: 'sensory_recall',
    description: '主动检索感知索引，返回候选实体与观察。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      limit: { type: 'number', minimum: 1, maximum: 20, description: '最多返回条目数' },
    },
    isConcurrencySafe: () => true,
    execute: async ({ query, limit = 5 }, exec = {}) => {
      const scopeId = scopeForExec(exec)
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        const result = runtime.matcher.retrieve(query, {
          sessionId: scopeId,
          workspaceId: workspace.workspaceId,
          taskState: { tool: 'sensory_recall' },
          includeUserGlobal: runtime.config.userGlobalEnabled,
        })
        const candidates = result.candidates
          .filter((candidate) => candidate.eligibility?.ok)
          .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
          .map((candidate) => ({
            id: candidate.id,
            entity: candidate.title,
            layer: candidate.layer,
            observations: candidate.canonicalFacts.length
              ? candidate.canonicalFacts.map((fact) => `${fact.subject} ${fact.predicate} ${fact.value}`)
              : [candidate.episodeSummary].filter(Boolean),
            source_refs: candidate.sourceRefs,
            relevance: candidate.relevance,
            associationWeight: 0,
          }))
        return json({ query, candidates, readOnly: true, associationWeight: 0 })
      }
      const viewer = { cwd: exec?.cwd, sessionId: exec?.agent?.session?.id, scopeId }
      let result = typeof matcher.matchSync === 'function'
        ? matcher.matchSync(query, viewer)
        : await matcher.match(query, viewer)
      if (result.engrams.length === 0) result = await matcher.match(query, viewer)
      const candidates = result.engrams.slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
        .map((hit) => {
          const entity = index.get(hit.id, scopeId)
          return {
            entity: hit.name,
            observations: entity?.observations ?? [hit.summary].filter(Boolean),
            source_refs: entity?.source_refs ?? hit.source_refs ?? [],
          }
        })
      return json({ query, candidates })
    },
  })

  const open = defineTool({
    name: 'sensory_open',
    description: '展开指定实体的感知索引原文，作为渐进披露第二层。',
    parameters: { entity: { type: 'string', required: true, description: '实体名或实体ID' } },
    isConcurrencySafe: () => true,
    execute: async ({ entity }, exec = {}) => {
      const scopeId = scopeForExec(exec)
      const name = cleanEntityName(entity)
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        const sensory = ledger.list('sensoryEntries', { scopeKind: 'session', scopeId })
          .find((entry) => entry.id === name || entry.title === name)
        if (sensory) {
          runtime.recordOpen({ target: sensory.id, sessionId: scopeId, workspaceId: workspace.workspaceId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), kind: 'sensory-open' })
          const sources = (sensory.sourceRefs ?? []).map((sourceRef) => ({ sourceRef, content: index.readSource(sourceRef) }))
          return json({ entity: sensory.title, id: sensory.id, layer: 'sensory', found: true, observations: sensory.canonicalFacts ?? [sensory.episodeSummary], sources, associationWeight: 1 })
        }
        const opened = bank.open(name, { workspaceId: workspace.workspaceId, sessionId: scopeId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), weight: 1 })
        if (opened) return json({ entity: opened.id, layer: 'bank', found: true, observations: opened.canonicalFacts ?? [opened.episode], sources: opened.sourceRefs ?? [], associationWeight: 1 })
        return json({ entity: name, found: false, sources: [] })
      }
      const record = index.get(name, scopeId) ?? index.getEntityByName(name, scopeId)
      if (!record || record.type !== 'entity') return json({ entity: name, found: false, sources: [] })
      const sources = (record.source_refs ?? []).map((sourceRef) => ({
        sourceRef,
        content: index.readSource(sourceRef),
      }))
      return json({ entity: record.name, found: true, observations: record.observations ?? [], sources })
    },
  })

  const store = defineTool({
    name: 'sensory_store',
    description: '显式写入一条感知索引。',
    parameters: { text: { type: 'string', required: true, description: '需要记住的事实文本' } },
    isConcurrencySafe: () => false,
    execute: async ({ text }, exec = {}) => {
      if (runtime) return json(await runtime.storeSensory(text, exec))
      const scopeId = scopeForExec(exec)
      const sourceRef = executionSource(exec, scopeId)
      const extracted = extractor.extractFromText(String(text), { ...sourceRef, role: 'assistant' })
      const entityIds = extracted.entities.map((entity) => index.addEntity({ ...entity, scopeId }))
      const relationIds = extracted.relations.map((relation) => {
        const from = relation.from ?? index.getEntityByName(relation.fromName, scopeId)?.id
        const to = relation.to ?? index.getEntityByName(relation.toName, scopeId)?.id
        return from && to ? index.addRelation({ ...relation, from, to, scopeId }) : null
      }).filter(Boolean)
      index.writeSource(sourceRef, { kind: 'sensory_store', role: 'assistant', text: String(text) })
      index.flush()
      matcher.markDirty?.()
      matcher.warm?.()
      const proposed = entityIds.filter((id) => String(id).startsWith('proposal_'))
      return json({ stored: proposed.length === 0, proposed: proposed.length > 0, sourceRef, entityIds, relationIds })
    },
  })

  const demote = defineTool({
    name: 'sensory_demote',
    description: '按source seq手动把一条工作层内容降级到感知索引。',
    parameters: { sourceSeq: { type: 'number', required: true, description: '工作层事件seq' } },
    isConcurrencySafe: () => false,
    execute: async ({ sourceSeq }, exec = {}) => json(runtime
      ? await runtime.demoteBySeq(sourceSeq, exec)
      : await demoter.demoteBySeq(sourceSeq, exec?.agent?.session?.id)),
  })

  const status = defineTool({
    name: 'sensory_status',
    description: '查看感知索引统计。',
    parameters: {},
    isConcurrencySafe: () => true,
    execute: async (_args, exec = {}) => {
      const scopeId = scopeForExec(exec)
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        return json(runtime.status(scopeId, workspace.workspaceId))
      }
      const tracked = (demoter.state?.tracked ?? []).filter((item) => (
        scopeId === 'global' ? (item.scopeId ?? 'global') === 'global' : String(item.scopeId) === scopeId
      ))
      const lastDemoted = tracked
        .filter((item) => item.demotedAt)
        .sort((left, right) => right.demotedAt - left.demotedAt)[0] ?? null
      const stats = index.stats(scopeId)
      return json({
        entityCount: stats.entityCount,
        relationCount: stats.relationCount,
        observationCount: stats.observationCount,
        roundsTracked: tracked.length,
        lastDemoted: lastDemoted ? {
          sourceSeq: lastDemoted.sourceSeq,
          demotedAt: lastDemoted.demotedAt,
        } : null,
        lastInjection: injector?.lastResult ? {
          queryText: injector.lastResult.queryText,
          durationMs: injector.lastResult.durationMs,
          entrySeqs: injector.lastResult.entrySeqs,
          proposedIndex: injector.lastInjection?.proposedIndex ?? null,
          insertIndex: injector.lastInjection?.insertIndex ?? null,
          beforeLength: injector.lastInjection?.beforeLength ?? null,
          afterLength: injector.lastInjection?.afterLength ?? null,
          fallback: injector.lastInjection?.fallback ?? null,
          toolBoundaryAdjusted: injector.lastInjection?.toolBoundaryAdjusted ?? null,
        } : null,
      })
    },
  })

  const tools = [recall, open, store, demote, status]
  if (auditor) {
    tools.push(defineTool({
      name: 'sensory_audit',
      description: '抽样审计感知记忆的Insertion/Contradiction/Deletion并按阈值执行写入熔断。',
      parameters: {
        sampleSize: { type: 'number', minimum: 1, maximum: 100, description: '抽样条目数' },
        apply: { type: 'boolean', default: false, description: '默认只读；true才应用熔断写模式' },
      },
      isConcurrencySafe: ({ apply } = {}) => apply !== true,
      execute: async ({ sampleSize = 20, apply = false }, exec = {}) => {
        const scopeId = scopeForExec(exec)
        const callsBefore = Number(auditor.stats?.llmCalls ?? 0)
        const audit = await auditor.audit(Math.max(1, Math.min(100, Math.floor(sampleSize))), scopeId)
        if (runtime) runtime.stats.auxiliaryPurposes['memory-audit'] += Math.max(0, Number(auditor.stats?.llmCalls ?? 0) - callsBefore)
        const circuit = apply ? await auditor.maybeCircuitBreak(audit) : { applied: false, readOnly: true }
        return json({ ...audit, circuit, apply })
      },
    }))
  }
  if (cache) {
    tools.push(defineTool({
      name: 'sensory_cache_status',
      description: '查看半持久cache、空结果补救、异步精抽与LLM慢路径成本统计。',
      parameters: {},
      isConcurrencySafe: () => true,
      execute: async (_args, exec = {}) => json({
        cache: cache.status(scopeForExec(exec)),
        rewriter: rewriter?.status?.() ?? null,
        extractor: llmExtractor?.status?.() ?? null,
        auditor: auditor?.status?.() ?? null,
        llm: llmClient?.status?.() ?? null,
      }),
    }))
  }

  if (debug) {
    const debugTool = ({ name, description, kind, title, parameters = {} }) => defineTool({
      name,
      description,
      parameters: { ...parameters, ...debugOutputParameters() },
      isConcurrencySafe: () => true,
      execute: async (args = {}, exec = {}) => {
        const payload = kind(args, exec)
        return debug.output(payload, {
          output: args.output,
          documentPath: args.documentPath,
          title,
        }, exec)
      },
    })

    tools.push(
      debugTool({
        name: 'sensory_debug_last_prompt',
        description: '查看本会话上次模型调用的完整prompt，包含system、全部tool schema、messages及请求属性；可输出到对话或工作区文档。',
        title: 'Sensory Debug - Last Complete Prompt',
        parameters: {
          requestKind: {
            type: 'string',
            enum: ['main', 'any', 'auxiliary'],
            default: 'main',
            description: '主对话请求、任意最近请求或插件慢路径请求',
          },
        },
        kind: (args, exec) => debug.fullPrompt(exec, args.requestKind ?? 'main'),
      }),
      debugTool({
        name: 'sensory_debug_cache_prompt',
        description: '查看半持久cache在上次目录prompt中的内容，以及hit_count、LRU、预算、置信度和注入属性。',
        title: 'Sensory Debug - Semipersistent Cache Prompt',
        kind: (_args, exec) => debug.cachePrompt(exec),
      }),
      debugTool({
        name: 'sensory_debug_index_prompt',
        description: '查看感知索引在上次目录prompt中的内容，以及实体、关系、观察、匹配、预算、seq和持久化属性。',
        title: 'Sensory Debug - Sensory Index Prompt',
        kind: (_args, exec) => debug.indexPrompt(exec),
      }),
      debugTool({
        name: 'sensory_debug_working_prompt',
        description: '查看上次主请求的工作层prompt/messages，以及role、source、block、token估算、tool-call配对和降级跟踪属性。',
        title: 'Sensory Debug - Working Layer Prompt',
        kind: (_args, exec) => debug.workingPrompt(exec),
      }),
    )

    tools.push(defineTool({
      name: 'sensory_clear_workspace_index',
      description: '清空当前感知索引作用域；session模式清当前会话，global模式清当前DSH profile的全局索引。必须显式confirm=true，并可把结果输出到对话或工作区文档。',
      parameters: {
        confirm: { type: 'boolean', required: true, description: '只有true才执行清理' },
        ...debugOutputParameters(),
      },
      isConcurrencySafe: () => false,
      execute: async (args = {}, exec = {}) => {
        const payload = await debug.clearWorkspaceIndex(exec, { confirm: args.confirm })
        return debug.output(payload, {
          output: args.output,
          documentPath: args.documentPath,
          title: 'Sensory Debug - Clear Workspace Index',
        }, exec)
      },
    }))
  }

  if (runtime) {
    tools.push(defineTool({
      name: 'memory_layer_status',
      description: '查看当前会话的工作、感知、半持久、记忆库、pending、预算和迁移状态。',
      parameters: {},
      isConcurrencySafe: () => true,
      execute: async (_args, exec = {}) => {
        const sessionId = scopeForExec(exec)
        const workspace = await runtime.workspace(exec?.agent)
        return json(runtime.status(sessionId, workspace.workspaceId))
      },
    }))
    tools.push(defineTool({
      name: 'memory_bank_open',
      description: '展开一个记忆库记录并将本轮记为一次强关联。',
      parameters: { record: { type: 'string', required: true, description: 'bank record ID' } },
      isConcurrencySafe: () => false,
      execute: async ({ record }, exec = {}) => {
        const sessionId = scopeForExec(exec)
        const workspace = await runtime.workspace(exec?.agent)
        const opened = runtime.openBank(record, { workspaceId: workspace.workspaceId, sessionId, turn: Number(exec?.turn ?? runtime.sessionState(sessionId).lastTurn) })
        return json(opened ? { found: true, record: opened, associationWeight: 1 } : { found: false, record })
      },
    }))
    tools.push(defineTool({
      name: 'memory_forget',
      description: '立即tombstone指定记忆，使其退出prompt、检索和投影；raw DSH事件继续保留。',
      parameters: {
        target: { type: 'string', required: true, description: 'record ID或事实文本' },
        scope: { type: 'string', enum: ['session', 'workspace', 'user-global'], default: 'workspace' },
      },
      isConcurrencySafe: () => false,
      execute: async ({ target, scope = 'workspace' }, exec = {}) => {
        const sessionId = scopeForExec(exec)
        const workspace = await runtime.workspace(exec?.agent)
        return json(runtime.forget({ target, scope, sessionId, workspaceId: workspace.workspaceId }))
      },
    }))
  }

  return tools
}

export function registerSensoryTools(ctx, services) {
  const disposers = createSensoryToolDefinitions(services).map((tool) => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposers.reverse()) dispose?.()
  }
}

export { TEXT_OUTPUT }
