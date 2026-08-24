import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh'))
const store = join(root, 'sensory-index', 'chunk-memory-v2')
const snapshotPath = join(store, 'ledger.snapshot.json')
const journalPath = join(store, 'ledger.journal.jsonl')

const collections = new Map()
const collection = (name) => {
  if (!collections.has(name)) collections.set(name, new Map())
  return collections.get(name)
}
const keyOf = (row) => `${row.scopeKind}\0${row.scopeId}\0${row.id}`

if (existsSync(snapshotPath)) {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  for (const [name, rows] of Object.entries(snapshot.collections ?? {})) {
    for (const row of rows ?? []) collection(name).set(keyOf(row), row)
  }
}

if (existsSync(journalPath)) {
  const lines = readFileSync(journalPath, 'utf8').split(/\r?\n/).filter(Boolean)
  for (const [index, line] of lines.entries()) {
    let mutation
    try { mutation = JSON.parse(line) } catch (error) {
      if (index === lines.length - 1) break
      throw error
    }
    const target = collection(mutation.collection)
    const key = keyOf(mutation)
    if (mutation.op === 'delete') target.delete(key)
    if (mutation.op === 'upsert') target.set(key, mutation.value)
  }
}

const visible = (name) => [...collection(name).values()].filter((row) => !row.tombstonedAt)
const chunks = [
  ...visible('sensoryChunks').map((chunk) => ({ layer: 'sensory', ...chunk })),
  ...visible('bankChunks').map((chunk) => ({ layer: 'bank', ...chunk })),
  ...visible('semipersistentRecords').flatMap((record) => (record.contextChunks ?? record.segment?.contextChunks ?? [])
    .map((chunk) => ({ layer: 'semipersistent', ...chunk, workspaceId: record.workspaceId }))),
  ...visible('sourceSegments').filter((segment) => segment.state === 'working')
    .flatMap((segment) => (segment.contextChunks ?? []).map((chunk) => ({ layer: 'working', ...chunk }))),
]

const unique = new Map(chunks.map((chunk) => [`${chunk.layer}\0${chunk.scopeId ?? ''}\0${chunk.id}`, chunk]))
const rows = [...unique.values()]
const countBy = (field) => rows.reduce((counts, row) => {
  const key = String(row[field] ?? 'unknown')
  counts[key] = (counts[key] ?? 0) + 1
  return counts
}, {})

console.log(JSON.stringify({
  architecture: 'parent-child-vector-v2',
  root: root.replace(/\\/g, '/'),
  store: store.replace(/\\/g, '/'),
  parentCount: rows.length,
  childSpanCount: rows.reduce((sum, parent) => sum + (parent.childSpans?.length ?? 0), 0),
  pendingParentCount: rows.filter((parent) => parent.state === 'pending-vector').length,
  activeParentCount: rows.filter((parent) => parent.state === 'active').length,
  byLayer: countBy('layer'),
  bySession: countBy('sessionId'),
  parents: rows.map((chunk) => ({
    layer: chunk.layer,
    id: chunk.id,
    sessionId: chunk.sessionId ?? null,
    workspaceId: chunk.workspaceId ?? null,
    sourceRefs: chunk.sourceRefs ?? [],
    tokenCount: chunk.tokenCount ?? null,
    format: chunk.format ?? 'text',
    label: chunk.label ?? null,
    temporalCurrent: chunk.temporalCurrent !== false,
    supersededBy: chunk.supersededBy ?? null,
    state: chunk.state ?? null,
    childSpanCount: chunk.childSpans?.length ?? 0,
    supersededRangeCount: chunk.supersededRanges?.length ?? 0,
    vectorSpec: chunk.vectorSpec ?? (chunk.vector ? {
      provider: chunk.vector.provider, model: chunk.vector.model,
      revision: chunk.vector.revision ?? null, dimensions: chunk.vector.dimensions,
    } : null),
    preview: String(chunk.coreText ?? '').replace(/\s+/g, ' ').slice(0, 160),
  })),
}, null, 2))
