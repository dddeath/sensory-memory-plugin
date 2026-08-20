import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { InjectionEngine } from '../lib/injection-engine.js'
import { SemipersistentCache } from '../lib/semipersistent-cache.js'
import { SensoryIndex } from '../lib/sensory-index.js'

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sensory-cache-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const index = new SensoryIndex(dir)
  const ids = {}
  for (const [name, seq] of [['项目A', 1], ['项目B', 2], ['项目C', 3]]) {
    ids[name] = index.addEntity({ name, observations: [`${name}的端口是80${seq}`], sourceRef: { sessionId: 's', seq } })
  }
  return { index, ids, cache: new SemipersistentCache({ index, config }) }
}

test('hit_count reaching three promotes the entity into semipersistent cache', (t) => {
  const { ids, cache } = fixture(t)
  cache.onHit(ids['项目A'])
  cache.onHit(ids['项目A'])
  const result = cache.onHit(ids['项目A'])
  assert.equal(result.hitCount, 3)
  assert.equal(result.cached, true)
  assert.equal(cache.status().entries[0].entity, '项目A')
})

test('renderCatalog places matched cache entries before ordinary index entries', (t) => {
  const { index, ids, cache } = fixture(t, { promoteAfter: 1 })
  cache.onHit(ids['项目B'])
  const hits = ['项目A', '项目B'].map((name) => {
    const entity = index.get(ids[name])
    return { id: entity.id, name, summary: entity.observations[0], source_refs: entity.source_refs }
  })
  const matcher = { match: async () => ({ engrams: hits }), matchSync: () => ({ engrams: hits }), sensoryIndex: index }
  const injector = new InjectionEngine({ matcher })
  injector.priorityCatalog = (values) => cache.renderPriority(values)
  const catalog = injector.renderCatalog(hits)
  assert.ok(catalog.indexOf('[cache] [[项目B]]') < catalog.indexOf('[[项目A]]'))
})

test('LRU evicts the least recently hit entry when capacity is full', (t) => {
  const { ids, cache } = fixture(t, { promoteAfter: 1, cacheMaxEntries: 2 })
  cache.onHit(ids['项目A'])
  cache.onHit(ids['项目B'])
  cache.onHit(ids['项目C'])
  const names = new Set(cache.status().entries.map((entry) => entry.entity))
  assert.equal(cache.status().entryCount, 2)
  assert.equal(names.has('项目A'), false)
  assert.equal(cache.status().lastEvicted.entityId, ids['项目A'])
})

test('cache render respects cacheBudgetTokens', (t) => {
  const { ids, cache } = fixture(t, { promoteAfter: 1, cacheBudgetTokens: 20 })
  cache.onHit(ids['项目A'])
  cache.onHit(ids['项目B'])
  cache.onHit(ids['项目C'])
  const rendered = cache.renderPriority()
  assert.ok(rendered.length < 3)
})
