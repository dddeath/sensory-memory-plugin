import { extname, isAbsolute, join, relative, resolve } from 'node:path'

import { atomicWriteFile } from './atomic-files.js'
import { estimateTokens } from './injection-engine.js'

const OUTPUT_MODES = Object.freeze(['conversation', 'document', 'both'])
const CATALOG_PURPOSES = new Set(['sensory-catalog', 'sensory-catalog-legacy'])
const PROMPT_FIELDS = new Set(['system', 'tools', 'messages'])

function clone(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return String(value)
  if (value === undefined) return null
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map((item) => clone(item, seen))
    seen.delete(value)
    return output
  }
  if (value instanceof Date) {
    seen.delete(value)
    return value.toISOString()
  }
  if (value instanceof Error) {
    seen.delete(value)
    return { name: value.name, message: value.message, stack: value.stack }
  }
  const output = {}
  for (const [key, item] of Object.entries(value)) output[key] = clone(item, seen)
  seen.delete(value)
  return output
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (typeof block?.text === 'string') return block.text
    if (typeof block?.output === 'string') return block.output
    if (block?.output !== undefined) return JSON.stringify(block.output)
    return ''
  }).filter(Boolean).join('\n')
}

function messageText(message) {
  if (typeof message?.text === 'string') return message.text
  return textOfContent(message?.content)
}

function sourceAttributes(source) {
  if (!source || typeof source !== 'object') return null
  return {
    kind: source.kind ?? null,
    plugin: source.plugin ?? null,
    sourcePlugin: source.sourcePlugin ?? null,
    purpose: source.purpose ?? null,
    sessionId: source.sessionId ?? null,
    turn: source.turn ?? null,
    step: source.step ?? null,
  }
}

function toolIds(message) {
  const calls = []
  const results = []
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'tool-call') calls.push(String(block.id ?? block.toolCallId ?? ''))
    if (block?.type === 'tool-result') results.push(String(block.toolCallId ?? block.id ?? ''))
  }
  return { calls: calls.filter(Boolean), results: results.filter(Boolean) }
}

function describeMessage(message, index) {
  const text = messageText(message)
  const blocks = Array.isArray(message?.content) ? message.content : []
  const ids = toolIds(message)
  return {
    index,
    id: message?.id ?? null,
    role: message?.role ?? null,
    source: sourceAttributes(message?.source),
    contentKind: typeof message?.content === 'string' ? 'string' : Array.isArray(message?.content) ? 'blocks' : typeof message?.content,
    blockCount: blocks.length,
    blockTypes: blocks.map((block) => block?.type ?? typeof block),
    textChars: text.length,
    estimatedTokens: estimateTokens(text),
    toolName: message?.toolName ?? message?.name ?? null,
    toolCallIds: ids.calls,
    toolResultIds: ids.results,
  }
}

function countBy(values) {
  const result = {}
  for (const value of values) {
    const key = String(value ?? 'unknown')
    result[key] = (result[key] ?? 0) + 1
  }
  return result
}

function requestAttributes(system, tools, messages, options) {
  const systemText = typeof system === 'string' ? system : JSON.stringify(system ?? '')
  const messageDescriptions = messages.map(describeMessage)
  return {
    frozen: Object.isFrozen(options) || Object.isFrozen(options?.messages),
    systemChars: systemText.length,
    systemEstimatedTokens: estimateTokens(systemText),
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool?.name ?? tool?.function?.name ?? null).filter(Boolean),
    messageCount: messages.length,
    messageRoles: countBy(messageDescriptions.map((message) => message.role)),
    messageSources: countBy(messageDescriptions.map((message) => message.source?.kind)),
    messageTextChars: messageDescriptions.reduce((total, message) => total + message.textChars, 0),
    messageEstimatedTokens: messageDescriptions.reduce((total, message) => total + message.estimatedTokens, 0),
  }
}

function promptOptions(options) {
  const result = {}
  for (const [key, value] of Object.entries(options ?? {})) {
    if (PROMPT_FIELDS.has(key) || key === 'signal') continue
    result[key] = clone(value)
  }
  return result
}

function catalogMessageOf(request) {
  const messages = request?.request?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind === 'plugin' && CATALOG_PURPOSES.has(message?.source?.purpose)) {
      return { index, message, text: messageText(message) }
    }
  }
  return null
}

function parseCatalog(text) {
  const entries = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(\[cache\]\s+)?\[\[([^\]]+)\]\]\s+\[seq\s+([^\]]+)\]\s*(.*)$/)
    if (!match) continue
    entries.push({
      line,
      cache: Boolean(match[1]),
      name: match[2].trim(),
      seq: match[3].trim(),
      summary: match[4].trim(),
    })
  }
  return entries
}

function scopeFrom({ matcher, config }, exec = {}) {
  return matcher?.scopeFor?.({
    sessionId: exec?.agent?.session?.id,
    scopeId: exec?.scopeId,
  }) ?? (config.indexScope === 'session' ? String(exec?.agent?.session?.id ?? 'global') : 'global')
}

function workspaceRoot(exec = {}) {
  return resolve(String(exec?.cwd ?? exec?.agent?.cwd ?? exec?.agent?.session?.header?.cwd ?? process.cwd()))
}

function within(root, candidate) {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function defaultFilename(kind, sequence) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${stamp}-${String(sequence).padStart(4, '0')}-${kind}.md`
}

function markdownDocument(title, payload) {
  const json = JSON.stringify(payload, null, 2)
  return `# ${title}\n\n- generatedAt: ${payload.generatedAt}\n- sessionId: ${payload.sessionId ?? ''}\n- scopeId: ${payload.scopeId ?? ''}\n\n${json.split('\n').map((line) => `    ${line}`).join('\n')}\n`
}

function documentContents(path, title, payload) {
  return extname(path).toLowerCase() === '.json'
    ? { format: 'json', contents: `${JSON.stringify(payload, null, 2)}\n` }
    : { format: 'markdown', contents: markdownDocument(title, payload) }
}

export class SensoryDebugService {
  constructor(services = {}) {
    Object.assign(this, services)
    this.config = services.config ?? {}
    this.requests = new Map()
    this.last = { any: null, main: null, auxiliary: null }
    this.skipTurnStopping = new Map()
    const maxSessions = Number(services.config?.debugMaxSessions ?? 32)
    this.maxSessions = Number.isFinite(maxSessions) ? Math.max(1, Math.floor(maxSessions)) : 32
    this.sequence = 0
    this.documentSequence = 0
  }

  captureRequest(options = {}, { auxiliary = false } = {}) {
    const started = performance.now()
    const system = clone(options.system ?? '')
    const tools = clone(Array.isArray(options.tools) ? options.tools : [])
    const messages = clone(Array.isArray(options.messages) ? options.messages : [])
    const sessionId = options.sessionId === undefined || options.sessionId === null ? null : String(options.sessionId)
    const snapshot = {
      schemaVersion: 1,
      sequence: ++this.sequence,
      capturedAt: new Date().toISOString(),
      sessionId,
      requestKind: auxiliary ? 'auxiliary' : 'main',
      purpose: options.purpose ?? options.metadata?.purpose ?? null,
      sourcePlugin: options.sourcePlugin ?? options.metadata?.sourcePlugin ?? null,
      request: {
        system,
        tools,
        messages,
        options: promptOptions(options),
      },
      attributes: requestAttributes(system, tools, messages, options),
    }
    snapshot.attributes.debugCaptureDurationMs = performance.now() - started
    this.last.any = snapshot
    this.last[auxiliary ? 'auxiliary' : 'main'] = snapshot
    if (sessionId !== null) {
      const current = this.requests.get(sessionId) ?? { any: null, main: null, auxiliary: null }
      current.any = snapshot
      current[auxiliary ? 'auxiliary' : 'main'] = snapshot
      this.requests.delete(sessionId)
      this.requests.set(sessionId, current)
      while (this.requests.size > this.maxSessions) this.requests.delete(this.requests.keys().next().value)
    }
    return {
      sequence: snapshot.sequence,
      sessionId: snapshot.sessionId,
      requestKind: snapshot.requestKind,
      capturedAt: snapshot.capturedAt,
    }
  }

  requestFor(exec = {}, requestKind = 'main') {
    const kind = ['main', 'any', 'auxiliary'].includes(requestKind) ? requestKind : 'main'
    const sessionId = exec?.agent?.session?.id
    if (sessionId !== undefined && sessionId !== null) return clone(this.requests.get(String(sessionId))?.[kind] ?? null)
    return clone(this.last[kind])
  }

  fullPrompt(exec = {}, requestKind = 'main') {
    const request = this.requestFor(exec, requestKind)
    return {
      schemaVersion: 1,
      kind: 'sensory-debug-last-prompt',
      generatedAt: new Date().toISOString(),
      sessionId: String(exec?.agent?.session?.id ?? request?.sessionId ?? ''),
      available: Boolean(request),
      requestKind,
      retainedSessions: this.requests.size,
      maxRetainedSessions: this.maxSessions,
      ...(request ? { capture: request } : { reason: 'no-captured-request-for-session' }),
    }
  }

  #catalogContext(exec = {}) {
    const request = this.requestFor(exec, 'main') ?? this.requestFor(exec, 'any')
    const message = catalogMessageOf(request)
    const text = message?.text ?? this.injector?.lastResult?.catalog ?? null
    return { request, message, text, entries: parseCatalog(text) }
  }

  cachePrompt(exec = {}) {
    const scopeId = scopeFrom(this, exec)
    const catalog = this.#catalogContext(exec)
    const status = this.cache?.status?.(scopeId) ?? null
    const promptEntries = catalog.entries.filter((entry) => entry.cache)
    return {
      schemaVersion: 1,
      kind: 'sensory-debug-cache-prompt',
      generatedAt: new Date().toISOString(),
      sessionId: String(exec?.agent?.session?.id ?? ''),
      scopeId,
      available: Boolean(catalog.text || status?.entryCount),
      prompt: promptEntries.map((entry) => entry.line).join('\n') || null,
      fullCatalogPrompt: catalog.text,
      entries: (status?.entries ?? []).map((entry) => ({
        ...entry,
        record: this.index.get(entry.entityId, scopeId),
        inLastPrompt: promptEntries.some((promptEntry) => promptEntry.name === entry.entity),
      })),
      attributes: {
        cache: status,
        promptEntryCount: promptEntries.length,
        promptEstimatedTokens: estimateTokens(promptEntries.map((entry) => entry.line).join('\n')),
        catalogMessage: catalog.message ? describeMessage(catalog.message.message, catalog.message.index) : null,
        lastInjection: clone(this.injector?.lastInjection ?? null),
      },
    }
  }

  indexPrompt(exec = {}) {
    const scopeId = scopeFrom(this, exec)
    const catalog = this.#catalogContext(exec)
    const promptEntries = catalog.entries.filter((entry) => !entry.cache)
    return {
      schemaVersion: 1,
      kind: 'sensory-debug-index-prompt',
      generatedAt: new Date().toISOString(),
      sessionId: String(exec?.agent?.session?.id ?? ''),
      scopeId,
      available: Boolean(catalog.text || this.index.count(scopeId)),
      prompt: promptEntries.map((entry) => entry.line).join('\n') || null,
      fullCatalogPrompt: catalog.text,
      entries: promptEntries.map((entry) => ({
        ...entry,
        record: this.index.getEntityByName(entry.name, scopeId),
      })),
      attributes: {
        indexDir: this.index.indexDir,
        index: this.index.stats(scopeId),
        writeMode: this.index.writeModeFor?.(scopeId) ?? null,
        proposal: this.index.proposalStatus?.(scopeId) ?? null,
        matcher: this.matcher?.status?.() ?? null,
        injectionConfig: clone(this.injector?.config ?? null),
        lastMatch: clone(this.injector?.lastResult ?? null),
        lastRender: clone(this.injector?.lastRender ?? null),
        lastInjection: clone(this.injector?.lastInjection ?? null),
        catalogMessage: catalog.message ? describeMessage(catalog.message.message, catalog.message.index) : null,
        promptEntryCount: promptEntries.length,
        promptEstimatedTokens: estimateTokens(promptEntries.map((entry) => entry.line).join('\n')),
      },
    }
  }

  workingPrompt(exec = {}) {
    const request = this.requestFor(exec, 'main') ?? this.requestFor(exec, 'any')
    const providerMessages = request?.request?.messages ?? []
    const working = providerMessages
      .map((message, providerIndex) => ({ message, providerIndex }))
      .filter(({ message }) => !(
        message?.source?.kind === 'plugin' && CATALOG_PURPOSES.has(message?.source?.purpose)
      ))
    const session = exec?.agent?.session
    let derived = []
    try { derived = clone(session?.deriveMessages?.() ?? []) } catch { derived = [] }
    const described = working.map(({ message, providerIndex }, index) => ({
      providerIndex,
      attributes: describeMessage(message, index),
      message: clone(message),
    }))
    const calls = new Set(described.flatMap((entry) => entry.attributes.toolCallIds))
    const results = new Set(described.flatMap((entry) => entry.attributes.toolResultIds))
    const tracked = (this.demoter?.state?.tracked ?? [])
      .filter((item) => String(item.sessionId) === String(session?.id ?? ''))
      .map((item) => ({
        key: item.key,
        sourceSeq: item.sourceSeq,
        turn: item.turn,
        role: item.role,
        kind: item.kind,
        toolName: item.toolName ?? null,
        unrefCount: item.unrefCount ?? 0,
        threshold: this.demoter.threshold?.(item) ?? null,
        demoted: Boolean(item.demoted),
        demotedAt: item.demotedAt ?? null,
        entityNames: item.entityNames ?? [],
        keywords: item.keywords ?? [],
        text: item.text,
      }))
    return {
      schemaVersion: 1,
      kind: 'sensory-debug-working-prompt',
      generatedAt: new Date().toISOString(),
      sessionId: String(session?.id ?? request?.sessionId ?? ''),
      scopeId: scopeFrom(this, exec),
      available: Boolean(request || derived.length),
      prompt: JSON.stringify(working.map((entry) => entry.message), null, 2),
      messages: described,
      attributes: {
        providerMessageCount: providerMessages.length,
        workingMessageCount: working.length,
        catalogMessagesExcluded: providerMessages.length - working.length,
        roles: countBy(described.map((entry) => entry.attributes.role)),
        sources: countBy(described.map((entry) => entry.attributes.source?.kind)),
        blockTypes: countBy(described.flatMap((entry) => entry.attributes.blockTypes)),
        totalTextChars: described.reduce((total, entry) => total + entry.attributes.textChars, 0),
        estimatedTokens: described.reduce((total, entry) => total + entry.attributes.estimatedTokens, 0),
        toolCalls: [...calls],
        toolResults: [...results],
        unmatchedToolCalls: [...calls].filter((id) => !results.has(id)),
        unmatchedToolResults: [...results].filter((id) => !calls.has(id)),
        session: {
          id: session?.id ?? null,
          cwd: exec?.cwd ?? exec?.agent?.cwd ?? session?.header?.cwd ?? null,
          eventCount: Array.isArray(session?.events) ? session.events.length : 0,
          derivedMessageCount: derived.length,
          header: clone(session?.header ?? null),
        },
        tracked,
      },
      sessionDerivedMessages: derived,
    }
  }

  async clearWorkspaceIndex(exec = {}, { confirm = false } = {}) {
    const sessionId = String(exec?.agent?.session?.id ?? '')
    const scopeId = scopeFrom(this, exec)
    const mode = this.config.indexScope === 'session' ? 'session' : 'global'
    const base = {
      schemaVersion: 1,
      kind: 'sensory-clear-workspace-index',
      generatedAt: new Date().toISOString(),
      sessionId,
      scopeId,
      workspace: workspaceRoot(exec),
      indexDir: this.index.indexDir,
      scopeMode: mode,
      effectiveTarget: mode === 'session' ? 'current-session-index-scope' : 'current-dsh-profile-global-index',
    }
    if (confirm !== true) return { ...base, cleared: false, confirmationRequired: true }
    const drain = await this.maintenance?.drain?.(mode === 'session' ? sessionId : null)
    const before = {
      index: this.index.stats(scopeId),
      cache: this.cache?.status?.(scopeId) ?? null,
      tracked: (this.demoter?.state?.tracked ?? []).filter((item) => String(item.scopeId ?? 'global') === scopeId).length,
    }
    const tracked = this.demoter?.clearScope?.(scopeId) ?? null
    const cache = this.cache?.dropScope?.(scopeId) ?? null
    const rewrite = this.rewriter?.dropScope?.(scopeId) ?? null
    const index = this.index.clearScope(scopeId)
    this.matcher?.markDirty?.()
    this.matcher?.warm?.()
    const turn = Number(exec?.turn ?? exec?.agent?.turn)
    this.skipTurnStopping.set(sessionId, {
      turn: Number.isFinite(turn) ? turn : null,
      clearedAt: Date.now(),
    })
    return {
      ...base,
      cleared: true,
      confirmationRequired: false,
      drain: drain ?? null,
      before,
      removed: { index, cache, rewrite, tracked },
      after: {
        index: this.index.stats(scopeId),
        cache: this.cache?.status?.(scopeId) ?? null,
        tracked: (this.demoter?.state?.tracked ?? []).filter((item) => String(item.scopeId ?? 'global') === scopeId).length,
      },
    }
  }

  consumeTurnStoppingSkip(sessionId, turn = null) {
    const key = String(sessionId ?? '')
    const pending = this.skipTurnStopping.get(key)
    if (!pending) return false
    const currentTurn = Number(turn)
    if (pending.turn !== null && Number.isFinite(currentTurn) && currentTurn !== pending.turn) {
      if (currentTurn > pending.turn) this.skipTurnStopping.delete(key)
      return false
    }
    this.skipTurnStopping.delete(key)
    return true
  }

  output(payload, { output = 'conversation', documentPath = null, title = 'Sensory Debug' } = {}, exec = {}) {
    const mode = OUTPUT_MODES.includes(output) ? output : 'conversation'
    if (mode === 'conversation') return JSON.stringify(payload, null, 2)
    const root = workspaceRoot(exec)
    let path
    if (documentPath) {
      const requested = isAbsolute(documentPath) ? resolve(documentPath) : resolve(root, documentPath)
      path = extname(requested) ? requested : join(requested, defaultFilename(payload.kind, ++this.documentSequence))
    } else {
      const directory = resolve(root, this.config.debugDocumentDir ?? 'results/sensory-debug')
      path = join(directory, defaultFilename(payload.kind, ++this.documentSequence))
    }
    if (!within(root, path)) throw new Error(`debug document path must stay inside current workspace: ${path}`)
    const rendered = documentContents(path, title, payload)
    atomicWriteFile(path, rendered.contents)
    const document = { written: true, path: path.replace(/\\/g, '/'), format: rendered.format }
    if (mode === 'document') return JSON.stringify({
      kind: payload.kind,
      generatedAt: payload.generatedAt,
      sessionId: payload.sessionId,
      scopeId: payload.scopeId ?? null,
      document,
    }, null, 2)
    return JSON.stringify({ ...payload, document }, null, 2)
  }
}

export const SENSORY_DEBUG_OUTPUT_MODES = OUTPUT_MODES
export const sensoryDebugInternals = { catalogMessageOf, describeMessage, parseCatalog, workspaceRoot }
