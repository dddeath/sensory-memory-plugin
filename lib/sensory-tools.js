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

const ANSWER_NOW = 'Use the evidence already returned and answer now.'

function normalizeQuery(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

function clipText(value, maxCharacters) {
  const text = String(value ?? '')
  if (text.length <= maxCharacters) return { text, truncated: false, omittedCharacters: 0 }
  return { text: `${text.slice(0, maxCharacters)}…`, truncated: true, omittedCharacters: text.length - maxCharacters }
}

function compactSourceContent(content, maxCharacters = 1200) {
  if (typeof content === 'string') return clipText(content, maxCharacters).text
  if (!content || typeof content !== 'object') return content
  const clipped = clipText(content.text ?? content.content ?? '', maxCharacters)
  return {
    seq: content.seq ?? null,
    role: content.role ?? null,
    sourceKind: content.sourceKind ?? content.source?.kind ?? null,
    text: clipped.text,
    truncated: clipped.truncated,
    omittedCharacters: clipped.omittedCharacters,
  }
}

function sourceRange(sourceRefs = []) {
  const seqs = sourceRefs.map((ref) => Number(ref?.seq)).filter(Number.isFinite).sort((left, right) => left - right)
  return { count: sourceRefs.length, firstSeq: seqs[0] ?? null, lastSeq: seqs.at(-1) ?? null }
}

function createRetrievalConvergence({ limit = null, keyForExec }) {
  const states = new Map()
  const hardLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : null
  const totalLimit = hardLimit ? hardLimit * 2 : null
  const state = (exec) => {
    const key = keyForExec(exec)
    if (!states.has(key)) {
      states.set(key, {
        key, actions: 0, recallCalls: 0, openCalls: 0,
        queries: new Set(), openedParents: new Set(), seenParents: new Set(), seenChildren: new Set(),
        matchedChildrenByParent: new Map(), noGainRecalls: 0,
      })
      if (states.size > 256) states.delete(states.keys().next().value)
    }
    return states.get(key)
  }
  const stop = (tool, current, reason, budgetExceeded = false) => ({
    tool,
    converged: true,
    budgetExceeded,
    reason,
    calls: { total: current.actions, recall: current.recallCalls, open: current.openCalls },
    instruction: ANSWER_NOW,
  })
  return {
    beforeRecall(query, exec) {
      const current = state(exec)
      const normalized = normalizeQuery(query)
      if (current.queries.has(normalized)) return stop('sensory_recall', current, 'duplicate-query')
      if ((hardLimit && current.recallCalls >= hardLimit) || (totalLimit && current.actions >= totalLimit)) {
        return stop('sensory_recall', current, 'retrieval-budget-exhausted', true)
      }
      current.queries.add(normalized)
      current.recallCalls += 1
      current.actions += 1
      return null
    },
    afterRecall(chunks, exec) {
      const current = state(exec)
      const newParentIds = []
      const newChildIds = []
      for (const chunk of chunks) {
        if (!current.seenParents.has(chunk.chunkId)) newParentIds.push(chunk.chunkId)
        current.seenParents.add(chunk.chunkId)
        const byId = current.matchedChildrenByParent.get(chunk.chunkId) ?? new Map()
        for (const child of chunk.matchedChildren ?? []) {
          if (!current.seenChildren.has(child.childId)) newChildIds.push(child.childId)
          current.seenChildren.add(child.childId)
          byId.set(child.childId, child)
        }
        current.matchedChildrenByParent.set(chunk.chunkId, byId)
      }
      const gained = newParentIds.length > 0 || newChildIds.length > 0
      current.noGainRecalls = gained ? 0 : current.noGainRecalls + 1
      const converged = !gained && current.recallCalls >= 2
      return {
        converged,
        reason: converged ? 'evidence-plateau' : gained ? 'new-evidence' : 'first-empty-recall',
        informationGain: { newParentIds, newChildIds, newParentCount: newParentIds.length, newChildCount: newChildIds.length },
        calls: { total: current.actions, recall: current.recallCalls, open: current.openCalls },
        ...(converged ? { instruction: ANSWER_NOW } : {}),
      }
    },
    beforeOpen(parentId, exec) {
      const current = state(exec)
      if (current.openedParents.has(parentId)) return stop('sensory_open', current, 'duplicate-parent-open')
      if ((hardLimit && current.openCalls >= hardLimit) || (totalLimit && current.actions >= totalLimit)) {
        return stop('sensory_open', current, 'retrieval-budget-exhausted', true)
      }
      current.openedParents.add(parentId)
      current.openCalls += 1
      current.actions += 1
      return null
    },
    afterOpen(exec) {
      const current = state(exec)
      const converged = Boolean(totalLimit && current.actions >= totalLimit)
      return {
        converged,
        reason: converged ? 'retrieval-budget-reached' : 'new-parent-opened',
        calls: { total: current.actions, recall: current.recallCalls, open: current.openCalls },
        ...(converged ? { instruction: ANSWER_NOW } : {}),
      }
    },
    matchedChildren(parentId, exec) {
      return [...(state(exec).matchedChildrenByParent.get(parentId)?.values() ?? [])]
        .sort((left, right) => Number(right.bestScore ?? 0) - Number(left.bestScore ?? 0))
    },
  }
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
  const scopeForExec = (exec = {}) => runtime
    ? String(exec?.agent?.session?.id ?? '')
    : matcher.scopeFor?.({
    sessionId: exec?.agent?.session?.id,
    scopeId: exec?.scopeId,
  }) ?? 'global'
  const effectiveRetrievalLimit = Number.isSafeInteger(retrievalToolCallLimit) && retrievalToolCallLimit > 0
    ? retrievalToolCallLimit
    : toolMode === 'retrieval-only' ? 3 : null
  const convergence = createRetrievalConvergence({
    limit: effectiveRetrievalLimit,
    keyForExec: (exec = {}) => {
      const sessionId = scopeForExec(exec)
      const turn = Number(exec?.turn ?? runtime?.sessionState?.(sessionId)?.lastTurn ?? 0)
      return `${sessionId}:${turn}`
    },
  })
  const recall = defineTool({
    name: 'sensory_recall',
    description: '主动检索当前会话已卸载的 Parent context；返回最高分 matchedChildren 片段与 Parent ID；只读且不增加关联。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词' },
      limit: { type: 'number', minimum: 1, maximum: 20, description: '最多返回条目数' },
    },
    isConcurrencySafe: () => true,
    execute: async ({ query, limit = 5 }, exec = {}) => {
      const gate = convergence.beforeRecall(query, exec)
      if (gate) return json(gate)
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
          .filter((candidate) => candidate.qualified)
          .slice(0, Math.max(1, Math.min(6, Math.floor(limit))))
          .map((candidate) => ({
            chunkId: candidate.id,
            label: candidate.label,
            layer: candidate.layer,
            excerpt: candidate.childHits[0]?.excerpt ?? clipText(candidate.coreText, 600).text,
            matchedChildren: candidate.childHits.slice(0, 2).map((child) => ({
              childId: child.childId,
              startOffset: child.startOffset,
              endOffset: child.endOffset,
              excerpt: child.excerpt,
              excerptTruncated: child.excerptTruncated,
              matchedQueries: child.matchedQueries,
              matchedQueryText: child.matchedQueryText,
              matchedTokens: child.matchedTokens,
              bestScore: child.bestScore,
              coverage: child.coverage,
            })),
            vector: candidate.vector ? { provider: candidate.vector.provider, model: candidate.vector.model, dimensions: candidate.vector.dimensions } : null,
            sourceRange: sourceRange(candidate.sourceRefs),
            relevance: candidate.relevance,
            lexicalRelevance: candidate.lexicalRelevance,
            vectorRelevance: candidate.vectorRelevance,
            matchedSubqueries: candidate.matchedSubqueries,
            admissionReasons: candidate.admissionReasons,
            associationWeight: 0,
          }))
        const progress = convergence.afterRecall(candidates, exec)
        const gainedParents = new Set(progress.informationGain.newParentIds)
        const gainedChildren = new Set(progress.informationGain.newChildIds)
        const disclosed = candidates.filter((candidate) => gainedParents.has(candidate.chunkId)
          || candidate.matchedChildren.some((child) => gainedChildren.has(child.childId)))
        return json({
          query,
          chunks: disclosed,
          readOnly: true,
          associationWeight: 0,
          disclosure: 'matched-child-first',
          convergence: progress,
        })
      }
      return json({ query, chunks: [], reason: 'chunk-runtime-unavailable' })
    },
  })

  const open = defineTool({
    name: 'sensory_open',
    description: '按 Parent chunk ID 展开已卸载上下文；优先返回 recall 命中的 Child 邻域，直接打开时返回有界 Parent current view，并记录一次显式强关联。',
    parameters: { chunk: { type: 'string', required: true, description: 'sensory_recall 或目录返回的 chunk ID' } },
    isConcurrencySafe: () => true,
    execute: async ({ chunk }, exec = {}) => {
      const scopeId = scopeForExec(exec)
      const id = cleanChunkId(chunk).replace(/^chunk:/, '')
      const gate = convergence.beforeOpen(id, exec)
      if (gate) return json({ chunkId: id, ...gate })
      if (runtime) {
        const workspace = await runtime.workspace(exec?.agent)
        const sensory = ledger.list('sensoryChunks', { scopeKind: 'session', scopeId })
          .find((entry) => entry.id === id || entry.pointer?.pointerId === id || entry.label === id)
        if (sensory) {
          runtime.recordOpen({ target: sensory.id, sessionId: scopeId, workspaceId: workspace.workspaceId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), kind: 'sensory-open' })
          const matchedChildren = convergence.matchedChildren(sensory.id, exec).slice(0, 3)
          const fullParent = renderCurrentParentView(sensory)
          const rawParent = String(sensory.coreText ?? fullParent)
          const expandedChildren = matchedChildren.map((child) => {
            const start = Math.max(0, Number(child.startOffset) || 0)
            const end = Math.max(start, Math.min(rawParent.length, Number(child.endOffset) || rawParent.length))
            const expanded = clipText(rawParent.slice(start, end) || child.excerpt, 3000)
            return { ...child, excerpt: expanded.text, excerptTruncated: expanded.truncated, omittedCharacters: expanded.omittedCharacters }
          })
          const disclosed = expandedChildren.length
            ? clipText(expandedChildren.map((child) => child.excerpt).join('\n\n'), 6000)
            : clipText(fullParent, 6000)
          const sources = (sensory.sourceRefs ?? []).slice(0, 4)
            .map((sourceRef) => ({ sourceRef, content: compactSourceContent(runtime.readSource(sourceRef)) }))
          const progress = convergence.afterOpen(exec)
          return json({
            chunkId: sensory.id, label: sensory.label, layer: 'sensory', found: true,
            coreText: disclosed.text,
            matchedChildren: expandedChildren,
            disclosure: {
              mode: expandedChildren.length ? 'expanded-matched-child' : 'bounded-parent-view',
              parentCharacters: fullParent.length,
              returnedCharacters: disclosed.text.length,
              truncated: disclosed.truncated,
              omittedCharacters: disclosed.omittedCharacters,
            },
            parent: { state: sensory.state, childSpanCount: sensory.childSpans?.length ?? 0, supersededRanges: sensory.supersededRanges ?? [] },
            vector: sensory.vectorSpec ?? (sensory.vector ? { provider: sensory.vector.provider, model: sensory.vector.model, revision: sensory.vector.revision ?? null, dimensions: sensory.vector.dimensions } : null),
            sourceRange: sourceRange(sensory.sourceRefs),
            sources, associationWeight: 1, convergence: progress,
          })
        }
        const opened = bank.open(id, { workspaceId: workspace.workspaceId, sessionId: scopeId, turn: Number(exec?.turn ?? runtime.sessionState(scopeId).lastTurn), weight: 1 })
        if (opened) {
          const progress = convergence.afterOpen(exec)
          const disclosed = clipText(opened.coreText ?? opened.contextText, 6000)
          return json({ chunkId: opened.id, label: opened.label, layer: 'bank', found: true, coreText: disclosed.text, disclosure: disclosed, sourceRange: sourceRange(opened.sourceRefs), associationWeight: 1, convergence: progress })
        }
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
    return tools.filter((tool) => allowed.has(tool.name))
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
