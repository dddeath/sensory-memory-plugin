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

export class HttpVectorEncoder {
  constructor({ endpoint, model = 'BAAI/bge-small-zh-v1.5', timeoutMs = 5000 } = {}) {
    if (!endpoint) throw new TypeError('vectorEndpoint is required for http vector provider')
    this.provider = 'http'
    this.model = String(model)
    this.endpoint = String(endpoint)
    this.timeoutMs = Math.max(250, Number(timeoutMs) || 5000)
    this.dimensions = null
    this.calls = 0
    this.failures = 0
  }

  async encodeBatch(texts) {
    this.calls += 1
    try {
      const result = await postJson(this.endpoint, { model: this.model, texts: texts.map(String) }, this.timeoutMs)
      const vectors = result.vectors ?? result.data?.map((item) => item.embedding)
      if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some((value) => !Array.isArray(value))) {
        throw new Error('vector endpoint response must contain one vector per text')
      }
      this.dimensions = vectors[0]?.length ?? this.dimensions
      return vectors.map((values) => ({ provider: this.provider, model: this.model, dimensions: values.length, values: normalizeVector(values.map(Number)) }))
    } catch (error) {
      this.failures += 1
      throw error
    }
  }

  async encode(text) { return (await this.encodeBatch([text]))[0] }
  status() { return { provider: this.provider, model: this.model, endpoint: this.endpoint, dimensions: this.dimensions, calls: this.calls, failures: this.failures } }
}

export function createVectorEncoder(config = {}) {
  if (config.vectorProvider === 'http' || config.vectorEndpoint) {
    return new HttpVectorEncoder({ endpoint: config.vectorEndpoint, model: config.vectorModel, timeoutMs: config.vectorTimeoutMs })
  }
  return new FeatureHashVectorEncoder({ dimensions: config.vectorDimensions ?? 384 })
}
