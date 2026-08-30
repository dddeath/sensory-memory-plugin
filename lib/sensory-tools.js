import { SENSORY_DEBUG_OUTPUT_MODES } from './sensory-debug.js'
import { renderCurrentParentView } from './layered-match-support.js'

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

function cleanChunkId(value) {
  return String(value ?? '').trim().replace(/^\[\[/, '').replace(/\]\]$/, '')
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
  matcher,
  cache = null,
  llmClient = null,
  debug = null,
  runtime = null,
  ledger = null,
  semipersistentLayer = null,
  bank = null,
  toolMode = 'full',
  retrievalToolCallLimit = null,
}) {
  const retrievalCalls = new Map()
  const withRetrievalBudget = (tool) => {
    if (!Number.isSafeInteger(retrievalToolCallLimit) || retrievalToolCallLimit < 1) return tool
    const execute = tool.execute
    return {
      ...tool,
      execute: async (args, exec = {}) => {
        const sessionId = String(exec?.agent?.session?.id ?? '')
        const turn = Number(exec?.turn ?? 0)
        const key = `${sessionId}:${turn}:${tool.name}`
        const used = retrievalCalls.get(key) ?? 0
        if (used >= retrievalToolCallLimit) {
          return json({ budgetExceeded: true, tool: tool.name, limit: retrievalToolCallLimit, instruction: 'Use the evidence already returned and answer now.' })
        }
        retrievalCalls.set(key, used + 1)
        return execute(args, exec)
      },
    }
  }
  const scopeForExec = (exec = {}) => runtime
    ? String(exec?.agent?.session?.id ?? '')
    : matcher.scopeFor?.({
    sessionId: exec?.agent?.session?.id,
    scopeId: exec?.scopeId,
  }) ?? 'global'
  const recall = defineTool({
    name: 'sensory_recall',
    description: '主动检索当前会话已卸载的 Parent context；Child 只负责定位，返回 Parent current view；只读且不增加关联。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      limit: { type: 'number', minimum: 1, maximum: 20, description: '最多返回条目数' },
    },
    isConcurrencySafe: () => true,
    execute: async ({ query, limit = 5 }, exec = {}) => {
      const scopeId = scopeForExec(exec)
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        const result = await runtime.matcher.retrieveAsync(query, {
          sessionId: scopeId,
          workspaceId: workspace.workspaceId,
          taskState: { tool: 'sensory_recall' },
          includeUserGlobal: runtime.config.userGlobalEnabled,
        })
        const candidates = result.candidates
          .filter((candidate) => candidate.eligibility?.ok)
          .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
          .map((candidate) => ({
            chunkId: candidate.id,
            label: candidate.label,
            layer: candidate.layer,
            excerpt: candidate.coreText.slice(0, 500),
            vector: candidate.vector ? { provider: candidate.vector.provider, model: candidate.vector.model, dimensions: candidate.vector.dimensions } : null,
            source_refs: candidate.sourceRefs,
            relevance: candidate.relevance,
            lexicalRelevance: candidate.lexicalRelevance,
            vectorRelevance: candidate.vectorRelevance,
            matchedSubqueries: candidate.matchedSubqueries,
            childHits: candidate.childHits,
            admissionReasons: candidate.admissionReasons,
            associationWeight: 0,
          }))
        return json({ query, chunks: candidates, readOnly: true, associationWeight: 0 })
      }
      return json({ query, chunks: [], reason: 'chunk-runtime-unavailable' })
    },
  })

  const open = defineTool({
    name: 'sensory_open',
    description: '按 Parent chunk ID 展开已卸载上下文的完整 current view 与原始来源，并记录一次显式强关联。',
    parameters: { chunk: { type: 'string', required: true, description: 'sensory_recall 或目录返回的 chunk ID' } },
    isConcurrencySafe: () => true,
    execute: async ({ chunk }, exec = {}) => {
      const scopeId = scopeForExec(exec)
      const id = cleanChunkId(chunk).replace(/^chunk:/, '')
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        const sensory = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId })
          .find((entry) => entry.id === id || entry.label === id)
        if (sensory) {
          runtime.recordOpen({ target: sensory.id, sessionId: scopeId, workspaceId: workspace.workspaceId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), kind: 'sensory-open' })
          const sources = (sensory.sourceRefs ?? []).map((sourceRef) => ({ sourceRef, content: runtime.readSource(sourceRef) }))
          return json({
            chunkId: sensory.id, label: sensory.label, layer: 'sensory', found: true,
            coreText: renderCurrentParentView(sensory), rawCoreText: sensory.coreText,
            parent: { state: sensory.state, childSpanCount: sensory.childSpans?.length ?? 0, supersededRanges: sensory.supersededRanges ?? [] },
            vector: sensory.vectorSpec ?? (sensory.vector ? { provider: sensory.vector.provider, model: sensory.vector.model, revision: sensory.vector.revision ?? null, dimensions: sensory.vector.dimensions } : null),
            sources, associationWeight: 1,
          })
        }
        const opened = bank.open(id, { workspaceId: workspace.workspaceId, sessionId: scopeId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), weight: 1 })
        if (opened) return json({ chunkId: opened.id, label: opened.label, layer: 'bank', found: true, coreText: opened.coreText, contextText: opened.contextText, sources: opened.sourceRefs ?? [], associationWeight: 1 })
        return json({ chunkId: id, found: false, sources: [] })
      }
      return json({ chunkId: id, found: false, reason: 'chunk-runtime-unavailable', sources: [] })
    },
  })

  const store = defineTool({
    name: 'sensory_store',
    description: '把文本按结构写成权威 Parent，并为嵌套 Child spans 建立向量定位视图。',
    parameters: { text: { type: 'string', required: true, description: '需要卸载到当前会话感知层的上下文' } },
    isConcurrencySafe: () => false,
    execute: async ({ text }, exec = {}) => {
      if (runtime) return json(await runtime.storeSensory(text, exec))
      return json({ stored: false, reason: 'chunk-runtime-unavailable' })
    },
  })

  const demote = defineTool({
    name: 'sensory_demote',
    description: '按source seq手动把一条工作层内容降级到感知索引。',
    parameters: { sourceSeq: { type: 'number', required: true, description: '工作层事件seq' } },
    isConcurrencySafe: () => false,
    execute: async ({ sourceSeq }, exec = {}) => json(runtime
      ? await runtime.demoteBySeq(sourceSeq, exec)
      : { demoted: false, reason: 'chunk-runtime-unavailable', sourceSeq }),
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
      return json({ architecture: 'parent-child-vector-v2', available: false, reason: 'chunk-runtime-unavailable' })
    },
  })

  const tools = [recall, open, store, demote, status]
  if (cache) {
    tools.push(defineTool({
      name: 'sensory_cache_status',
      description: '查看半持久 Parent 投影、预算和向量检索慢路径统计。',
      parameters: {},
      isConcurrencySafe: () => true,
      execute: async (_args, exec = {}) => json({
        cache: cache.status(scopeForExec(exec)),
        matcher: matcher?.status?.() ?? null,
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
        description: '查看半持久 Parent 快照、投影状态、预算和注入属性。',
        title: 'Sensory Debug - Semipersistent Cache Prompt',
        kind: (_args, exec) => debug.cachePrompt(exec),
      }),
      debugTool({
        name: 'sensory_debug_index_prompt',
        description: '查看感知层 Parent/Child、Child 命中分数、coverage、来源、seq和持久化属性。',
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
      parameters: { record: { type: 'string', required: true, description: 'bank chunk ID' } },
      isConcurrencySafe: () => false,
      execute: async ({ record }, exec = {}) => {
        const sessionId = scopeForExec(exec)
        const workspace = await runtime.workspace(exec?.agent)
        const opened = runtime.openBank(record, { workspaceId: workspace.workspaceId, sessionId, turn: Number(exec?.turn ?? runtime.sessionState(sessionId).lastTurn) })
        return json(opened ? { found: true, chunk: opened, associationWeight: 1 } : { found: false, record })
      },
    }))
    tools.push(defineTool({
      name: 'memory_forget',
      description: '立即tombstone指定记忆，使其退出prompt、检索和投影；raw DSH事件继续保留。',
      parameters: {
        target: { type: 'string', required: true, description: 'chunk ID或上下文文本' },
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

  if (toolMode === 'retrieval-only') {
    const allowed = new Set(['sensory_recall', 'sensory_open'])
    return tools.filter((tool) => allowed.has(tool.name)).map(withRetrievalBudget)
  }
  if (toolMode === 'compression-only') return []
  return tools
}

export function registerSensoryTools(ctx, services) {
  const disposers = createSensoryToolDefinitions(services).map((tool) => ctx.tools.register(tool))
  return () => {
    for (const dispose of disposers.reverse()) dispose?.()
  }
}

export { TEXT_OUTPUT }
