import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { appendAndFsync, atomicWriteFile, atomicWriteJson } from './atomic-files.js'

export const LAYER_LEDGER_VERSION = 2

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function scopeKindOf(value) {
  return String(value ?? 'session') || 'session'
}

function scopeIdOf(value) {
  const scope = String(value ?? '').trim()
  if (!scope) throw new TypeError('scopeId is required')
  return scope
}

function mapKey(scopeKind, scopeId, id) {
  return `${scopeKindOf(scopeKind)}\u0000${scopeIdOf(scopeId)}\u0000${String(id)}`
}

function parseLines(path) {
  if (!existsSync(path)) return { records: [], recovery: null }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  let last = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) { last = index; break }
  }
  const records = []
  let recovery = null
  for (let index = 0; index <= last; index += 1) {
    if (!lines[index].trim()) continue
    try {
      records.push(JSON.parse(lines[index]))
    } catch (error) {
      if (index !== last) throw new Error(`Invalid Layer Ledger journal at ${path}:${index + 1}: ${error.message}`)
      recovery = { type: 'truncated-tail', line: index + 1, error: String(error) }
      atomicWriteFile(path, records.length ? `${records.map((item) => JSON.stringify(item)).join('\n')}\n` : '')
    }
  }
  return { records, recovery }
}

export class MemoryLedger {
  constructor(rootDir, config = {}) {
    if (!String(rootDir ?? '').trim()) throw new TypeError('rootDir is required')
    this.rootDir = resolve(rootDir)
    this.snapshotPath = join(this.rootDir, 'ledger.snapshot.json')
    this.journalPath = join(this.rootDir, 'ledger.journal.jsonl')
    this.metaPath = join(this.rootDir, 'storage-meta.json')
    this.config = {
      journalCompactAfter: Math.max(10, config.journalCompactAfter ?? 2000),
    }
    this.sequence = 0
    this.journalRecordCount = 0
    this.collections = new Map()
    this.queues = new Map()
    this.recovery = null
    this.lastMutationAt = null
    mkdirSync(this.rootDir, { recursive: true })
    if (!existsSync(this.journalPath)) atomicWriteFile(this.journalPath, '')
    this.#load()
  }

  #collection(name) {
    const key = String(name)
    if (!this.collections.has(key)) this.collections.set(key, new Map())
    return this.collections.get(key)
  }

  #load() {
    if (existsSync(this.snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(this.snapshotPath, 'utf8'))
      if (snapshot?.version !== LAYER_LEDGER_VERSION) throw new Error(`Unsupported Layer Ledger snapshot version: ${snapshot?.version}`)
      this.sequence = Number(snapshot.sequence) || 0
      for (const [collection, rows] of Object.entries(snapshot.collections ?? {})) {
        const target = this.#collection(collection)
        for (const row of rows ?? []) target.set(mapKey(row.scopeKind, row.scopeId, row.id), clone(row))
      }
    }
    const journal = parseLines(this.journalPath)
    this.recovery = journal.recovery
    for (const mutation of journal.records) {
      this.#apply(mutation)
      this.sequence = Math.max(this.sequence, Number(mutation.sequence) || 0)
      this.journalRecordCount += 1
    }
  }

  #apply(mutation) {
    if (mutation?.version !== LAYER_LEDGER_VERSION) throw new Error(`Unsupported Layer Ledger mutation version: ${mutation?.version}`)
    const target = this.#collection(mutation.collection)
    const key = mapKey(mutation.scopeKind, mutation.scopeId, mutation.id)
    if (mutation.op === 'delete') target.delete(key)
    else if (mutation.op === 'upsert') target.set(key, clone(mutation.value))
    else throw new Error(`Unknown Layer Ledger mutation operation: ${mutation.op}`)
  }

  mutate({ scopeKind = 'session', scopeId, collection, op = 'upsert', id, value }) {
    const normalizedScopeId = scopeIdOf(scopeId)
    if (!String(collection ?? '').trim()) throw new TypeError('collection is required')
    if (!String(id ?? '').trim()) throw new TypeError('id is required')
    this.sequence += 1
    const mutation = {
      version: LAYER_LEDGER_VERSION,
      sequence: this.sequence,
      scopeKind: scopeKindOf(scopeKind),
      scopeId: normalizedScopeId,
      collection: String(collection),
      op,
      id: String(id),
      ...(op === 'upsert' ? { value: clone({ ...value, scopeKind: scopeKindOf(scopeKind), scopeId: normalizedScopeId, id: String(id) }) } : {}),
    }
    this.#apply(mutation)
    appendAndFsync(this.journalPath, `${JSON.stringify(mutation)}\n`)
    this.journalRecordCount += 1
    this.lastMutationAt = Date.now()
    if (this.journalRecordCount >= this.config.journalCompactAfter) this.compact()
    return clone(op === 'upsert' ? mutation.value : mutation)
  }

  upsert(collection, value, { scopeKind = value?.scopeKind ?? 'session', scopeId = value?.scopeId, id = value?.id } = {}) {
    return this.mutate({ scopeKind, scopeId, collection, op: 'upsert', id, value })
  }

  delete(collection, id, { scopeKind = 'session', scopeId } = {}) {
    return this.mutate({ scopeKind, scopeId, collection, op: 'delete', id })
  }

  get(collection, id, { scopeKind = null, scopeId = null } = {}) {
    if (scopeKind !== null && scopeId !== null) return clone(this.#collection(collection).get(mapKey(scopeKind, scopeId, id)) ?? null)
    for (const value of this.#collection(collection).values()) {
      if (String(value.id) === String(id)
        && (scopeKind === null || value.scopeKind === scopeKind)
        && (scopeId === null || value.scopeId === String(scopeId))) return clone(value)
    }
    return null
  }

  list(collection, { scopeKind = null, scopeId = null, includeTombstoned = false } = {}) {
    return [...this.#collection(collection).values()]
      .filter((value) => (scopeKind === null || value.scopeKind === scopeKind)
        && (scopeId === null || value.scopeId === String(scopeId))
        && (includeTombstoned || !value.tombstonedAt))
      .map(clone)
  }

  dropScope(scopeKind, scopeId, collections = null) {
    const names = collections ?? [...this.collections.keys()]
    let removed = 0
    for (const collection of names) {
      for (const value of this.list(collection, { scopeKind, scopeId, includeTombstoned: true })) {
        this.delete(collection, value.id, { scopeKind, scopeId })
        removed += 1
      }
    }
    return { scopeKind, scopeId: String(scopeId), removed }
  }

  enqueue(scopeKey, operation) {
    const key = String(scopeKey)
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    this.queues.set(key, current)
    current.finally(() => { if (this.queues.get(key) === current) this.queues.delete(key) }).catch(() => {})
    return current
  }

  async drain(scopeKey = null, timeoutMs = 5000) {
    const pending = scopeKey === null
      ? [...this.queues.values()]
      : [this.queues.get(String(scopeKey))].filter(Boolean)
    if (pending.length === 0) return { ok: true, timeout: false, pending: 0 }
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), Math.max(1, timeoutMs)) })
    const value = await Promise.race([Promise.allSettled(pending), timeout])
    clearTimeout(timer)
    if (value?.timeout) return { ok: false, timeout: true, pending: pending.length }
    const failures = value.filter((item) => item.status === 'rejected').map((item) => String(item.reason))
    return { ok: failures.length === 0, timeout: false, pending: this.queues.size, failures }
  }

  compact() {
    const collections = {}
    for (const [name, values] of this.collections) collections[name] = [...values.values()].map(clone)
    atomicWriteJson(this.snapshotPath, {
      version: LAYER_LEDGER_VERSION,
      sequence: this.sequence,
      compactedAt: Date.now(),
      collections,
    })
    atomicWriteFile(this.journalPath, '')
    this.journalRecordCount = 0
    atomicWriteJson(this.metaPath, {
      version: LAYER_LEDGER_VERSION,
      sequence: this.sequence,
      snapshot: 'ledger.snapshot.json',
      journal: 'ledger.journal.jsonl',
      updatedAt: Date.now(),
    })
    return this.status()
  }

  flush() {
    atomicWriteJson(this.metaPath, {
      version: LAYER_LEDGER_VERSION,
      sequence: this.sequence,
      journalRecordCount: this.journalRecordCount,
      updatedAt: Date.now(),
    })
    return this.status()
  }

  status() {
    return {
      version: LAYER_LEDGER_VERSION,
      rootDir: this.rootDir,
      sequence: this.sequence,
      journalRecordCount: this.journalRecordCount,
      pendingQueues: this.queues.size,
      recovery: clone(this.recovery),
      lastMutationAt: this.lastMutationAt,
      collections: Object.fromEntries([...this.collections].map(([name, values]) => [name, values.size])),
    }
  }
}
