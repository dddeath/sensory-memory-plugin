import http from 'node:http'
import https from 'node:https'

function tokens(text) {
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase()
  const result = []
  for (const match of normalized.matchAll(/[a-z][\w-]*|\d+(?:\.\d+)?/g)) result.push(match[0])
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) result.push(run)
    else for (let index = 0; index < run.length - 1; index += 1) result.push(run.slice(index, index + 2))
  }
  return result
}

// Functional feature hashing for the built-in zero-dependency prototype.
// This is not an integrity checksum and is never used as an audit guard.
function fnv32(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function normalizeVector(values) {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (!norm) return values
  return values.map((value) => Math.round((value / norm) * 1e6) / 1e6)
}

export function cosineSimilarity(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += Number(left[index]) * Number(right[index])
    leftNorm += Number(left[index]) ** 2
    rightNorm += Number(right[index]) ** 2
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

export class FeatureHashVectorEncoder {
  constructor({ dimensions = 384 } = {}) {
    this.provider = 'builtin'
    this.model = 'feature-hash-cjk-v1'
    this.dimensions = Math.max(64, Number(dimensions) || 384)
    this.calls = 0
  }

  encodeSync(text) {
    this.calls += 1
    const values = Array(this.dimensions).fill(0)
    for (const token of tokens(text)) {
      const hash = fnv32(token)
      const slot = hash % this.dimensions
      values[slot] += (hash & 0x80000000) === 0 ? 1 : -1
    }
    return {
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
      values: normalizeVector(values),
    }
  }

  async encode(text) { return this.encodeSync(text) }
  async encodeBatch(texts) { return texts.map((text) => this.encodeSync(text)) }
  status() { return { provider: this.provider, model: this.model, dimensions: this.dimensions, calls: this.calls, zeroDependency: true } }
}

export class LexicalOnlyVectorEncoder {
  constructor() {
    this.provider = 'none'
    this.model = null
    this.dimensions = null
    this.calls = 0
  }

  encodeSync() { return null }
  async encode() { return null }
  async encodeBatch(texts) { return texts.map(() => null) }
  status() { return { provider: this.provider, model: null, dimensions: null, calls: this.calls, vectorAvailable: false, lexicalOnly: true } }
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const body = JSON.stringify(payload)
    const request = transport.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(`vector endpoint ${response.statusCode}: ${text.slice(0, 300)}`))
        try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('vector endpoint timeout')))
    request.on('error', reject)
    request.end(body)
  })
}

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.get(target, { timeout: timeoutMs }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if ((response.statusCode ?? 500) >= 400) return reject(new Error(`vector health ${response.statusCode}: ${text.slice(0, 300)}`))
        try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('vector health timeout')))
    request.on('error', reject)
  })
}

export class HttpVectorEncoder {
  constructor({
    endpoint,
    model = 'intfloat/multilingual-e5-small',
    revision = null,
    dimensions = 384,
    batchSize = 32,
    timeoutMs = 5000,
    required = false,
  } = {}) {
    if (!endpoint) throw new TypeError('vectorEndpoint is required for http vector provider')
    this.provider = 'http'
    this.model = String(model)
    this.revision = revision ? String(revision) : null
    this.endpoint = String(endpoint)
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 5000)
    this.dimensions = Number(dimensions) || null
    this.batchSize = Math.max(1, Math.min(128, Number(batchSize) || 32))
    this.required = required === true
    this.calls = 0
    this.failures = 0
    this.vectorAvailable = null
    this.lastError = null
  }

  async encodeBatch(texts, { kind = 'passage' } = {}) {
    try {
      const output = []
      const input = texts.map(String)
      for (let offset = 0; offset < input.length; offset += this.batchSize) {
        const batch = input.slice(offset, offset + this.batchSize)
        this.calls += 1
        const result = await postJson(this.endpoint, {
          protocol: 'dsh-embedding-sidecar/1',
          model: this.model,
          ...(this.revision ? { revision: this.revision } : {}),
          kind: kind === 'query' ? 'query' : 'passage',
          texts: batch,
        }, this.timeoutMs)
        if (result.protocol && result.protocol !== 'dsh-embedding-sidecar/1') throw new Error(`unexpected vector protocol: ${result.protocol}`)
        if (result.model && result.model !== this.model) throw new Error(`unexpected vector model: ${result.model}`)
        if (this.revision && result.revision && result.revision !== this.revision) throw new Error(`unexpected vector revision: ${result.revision}`)
        const vectors = result.vectors ?? result.data?.map((item) => item.embedding)
        if (!Array.isArray(vectors) || vectors.length !== batch.length || vectors.some((value) => !Array.isArray(value))) {
          throw new Error('vector endpoint response must contain one vector per text')
        }
        const dimensions = vectors[0]?.length ?? this.dimensions
        if (this.dimensions && dimensions !== this.dimensions) throw new Error(`unexpected vector dimensions: ${dimensions}`)
        if (result.dimensions && Number(result.dimensions) !== dimensions) throw new Error(`vector response dimensions mismatch: ${result.dimensions}`)
        this.dimensions = dimensions
        output.push(...vectors.map((values) => ({
          provider: this.provider,
          model: this.model,
          revision: result.revision ?? this.revision,
          dimensions: values.length,
          normalized: true,
          values: normalizeVector(values.map(Number)),
        })))
      }
      this.vectorAvailable = true
      this.lastError = null
      return output
    } catch (error) {
      this.failures += 1
      this.vectorAvailable = false
      this.lastError = String(error?.message ?? error)
      if (this.required) throw error
      return texts.map(() => null)
    }
  }

  async encode(text, { kind = 'query' } = {}) { return (await this.encodeBatch([text], { kind }))[0] }
  async health() {
    const target = new URL(this.endpoint)
    target.pathname = target.pathname.replace(/\/embed\/?$/, '/health')
    const result = await getJson(target, this.timeoutMs)
    if (result.protocol !== 'dsh-embedding-sidecar/1' || result.status !== 'ready') throw new Error('embedding sidecar is not ready')
    if (result.model !== this.model) throw new Error(`unexpected vector model: ${result.model}`)
    if (this.revision && result.revision !== this.revision) throw new Error(`unexpected vector revision: ${result.revision}`)
    if (this.dimensions && Number(result.dimensions) !== this.dimensions) throw new Error(`unexpected vector dimensions: ${result.dimensions}`)
    this.vectorAvailable = true
    this.lastError = null
    return result
  }
  status() { return { provider: this.provider, model: this.model, revision: this.revision, endpoint: this.endpoint, dimensions: this.dimensions, batchSize: this.batchSize, timeoutMs: this.timeoutMs, required: this.required, vectorAvailable: this.vectorAvailable, calls: this.calls, failures: this.failures, lastError: this.lastError } }
}

export function createVectorEncoder(config = {}) {
  if (config.vectorProvider === 'http' || config.vectorEndpoint) {
    return new HttpVectorEncoder({
      endpoint: config.vectorEndpoint,
      model: config.vectorModel,
      revision: config.vectorRevision,
      dimensions: config.vectorDimensions,
      batchSize: config.vectorBatchSize,
      timeoutMs: config.vectorTimeoutMs,
      required: config.vectorRequired,
    })
  }
  if (config.vectorProvider === 'feature-hash') return new FeatureHashVectorEncoder({ dimensions: config.vectorDimensions ?? 384 })
  return new LexicalOnlyVectorEncoder()
}
