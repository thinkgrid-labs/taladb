/**
 * TalaDB browser benchmark workload.
 *
 * Runs inside a real browser page served by scripts/bench-web.mjs. Talks to
 * the @taladb/web worker (WASM + OPFS) directly over its message protocol —
 * the same postMessage + JSON path the `taladb` wrapper uses, so timings
 * include the full JS↔worker↔WASM round-trip an application pays.
 *
 * Mirrors scripts/bench.mjs (same seeded data, same operations) with browser-
 * appropriate scales. Emits progress as `BENCH_PROGRESS …` console lines and
 * the final result as one `BENCH_JSON {…}` line.
 */

// ---------------------------------------------------------------------------
// Worker protocol client
// ---------------------------------------------------------------------------

class WorkerClient {
  constructor(url) {
    this.worker = new Worker(url, { type: 'module', name: 'taladb' })
    this.nextId = 1
    this.pending = new Map()
    this.worker.onmessage = (e) => {
      const { id, result, error } = e.data
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (error !== undefined) p.reject(new Error(error))
      else p.resolve(result)
    }
    this.worker.onerror = (e) => {
      const err = new Error(`worker error: ${e.message ?? 'unknown'}`)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }
  call(op, args = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, ...args })
    })
  }
}

/** Collection-scoped convenience wrapper mirroring the taladb API. */
class Col {
  constructor(client, name) {
    this.c = client
    this.name = name
  }
  async insert(doc) {
    return this.c.call('insert', { collection: this.name, docJson: JSON.stringify(doc) })
  }
  async insertMany(docs) {
    const r = await this.c.call('insertMany', { collection: this.name, docsJson: JSON.stringify(docs) })
    return typeof r === 'string' ? JSON.parse(r) : r
  }
  async find(filter) {
    const r = await this.c.call('find', { collection: this.name, filterJson: JSON.stringify(filter) })
    return typeof r === 'string' ? JSON.parse(r) : r
  }
  async findOne(filter) {
    const r = await this.c.call('findOne', { collection: this.name, filterJson: JSON.stringify(filter) })
    return typeof r === 'string' && r ? JSON.parse(r) : r
  }
  async updateOne(filter, update) {
    return this.c.call('updateOne', { collection: this.name, filterJson: JSON.stringify(filter), updateJson: JSON.stringify(update) })
  }
  async deleteOne(filter) {
    return this.c.call('deleteOne', { collection: this.name, filterJson: JSON.stringify(filter) })
  }
  async count(filter) {
    return this.c.call('count', { collection: this.name, filterJson: JSON.stringify(filter) })
  }
  async createIndex(field) {
    return this.c.call('createIndex', { collection: this.name, field })
  }
  async createVectorIndex(field, dimensions) {
    return this.c.call('createVectorIndex', { collection: this.name, field, dimensions })
  }
  async findNearest(field, query, topK, filter) {
    const r = await this.c.call('findNearest', {
      collection: this.name,
      field,
      queryJson: JSON.stringify(query),
      topK,
      filterJson: filter ? JSON.stringify(filter) : null,
    })
    return typeof r === 'string' ? JSON.parse(r) : r
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (mirrors scripts/bench.mjs)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(42)

async function bench(fn, { warmup = 3, maxIters = 200, minIters = 5, budgetMs = 3000 } = {}) {
  for (let i = 0; i < warmup; i++) await fn(i)
  const samples = []
  let spent = 0
  for (let i = 0; i < maxIters; i++) {
    const t0 = performance.now()
    await fn(i)
    const ms = performance.now() - t0
    samples.push(ms)
    spent += ms
    if (spent > budgetMs && samples.length >= minIters) break
  }
  samples.sort((a, b) => a - b)
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))]
  return { median: q(0.5), p95: q(0.95), iters: samples.length }
}

const CATEGORIES = ['support', 'billing', 'onboarding', 'api', 'security', 'mobile', 'desktop', 'account']
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt', 'tl', 'ko', 'zh', 'it']

function makeDoc(i) {
  return {
    title: `Article ${i}: how to configure feature ${i % 97}`,
    category: CATEGORIES[i % CATEGORIES.length],
    locale: LOCALES[i % LOCALES.length],
    userId: `user-${i % 10_000}`,
    views: Math.floor(rand() * 100_000),
    publishedAt: 1_700_000_000_000 + i * 1000,
    draft: i % 5 === 0,
  }
}

function makeVector(dims) {
  const v = new Array(dims)
  let norm = 0
  for (let i = 0; i < dims; i++) {
    v[i] = rand() * 2 - 1
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dims; i++) v[i] /= norm
  return v
}

// Report back to the bench-web.mjs server (headless Chrome gives us no
// convenient stdout, so the page phones home over HTTP).
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
const progress = (msg) => {
  console.log(`BENCH_PROGRESS ${msg}`)
  post('/__bench/progress', { msg })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const rows = []
const section = (title) => rows.push({ section: title })
const row = (name, detail, median, extra = {}) => rows.push({ name, detail, median, ...extra })

/** Probe real OPFS support (sync access handles only exist in workers). */
async function detectOpfs() {
  const code = `self.onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('__probe',{create:true});const h=await f.createSyncAccessHandle();h.close();await r.removeEntry('__probe');postMessage('ok')}catch(e){postMessage('no')}}`
  const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
  const result = new Promise((res) => { w.onmessage = (e) => res(e.data) })
  w.postMessage(0)
  const ok = (await result) === 'ok'
  w.terminate()
  return ok
}

async function main() {
  // ?quick=1 — tiny scales for smoke-testing the harness (not for publishing).
  const QUICK = new URLSearchParams(location.search).has('quick')
  const opfs = await detectOpfs()
  const workerUrl = new URL('/packages/taladb-web/worker/taladb.worker.js', location.origin)
  const client = new WorkerClient(workerUrl)
  await client.call('init', { dbName: 'bench.db' })
  progress(`worker initialised (opfs=${opfs}, quick=${QUICK})`)

  const QUERY_N = QUICK ? 5_000 : 100_000
  const VECTOR_NS = QUICK ? [1_000] : [1_000, 10_000, 50_000]
  const HYBRID_N = VECTOR_NS[VECTOR_NS.length - 1]
  const DIMS = 384
  const TOP_K = 10

  // 1. Document writes ------------------------------------------------------
  {
    const col = new Col(client, 'writes')
    section('Document writes (OPFS-backed)')
    {
      let i = 0
      const r = await bench(() => col.insert(makeDoc(i++)), { warmup: 10, maxIters: 500, budgetMs: 4000 })
      row('insert (single doc)', 'one transaction per call', r.median, { unit: 'opsPerSec', iters: r.iters })
    }
    for (const batch of [100, 1000]) {
      let i = 0
      const r = await bench(() => col.insertMany(Array.from({ length: batch }, () => makeDoc(i++))), { warmup: 2, maxIters: 30, budgetMs: 4000 })
      row(`insertMany (batch ${batch})`, 'single transaction per batch', r.median, { unit: 'docsPerSec', batch, iters: r.iters })
    }
    const ids = await new Col(client, 'writes').insertMany(Array.from({ length: 1000 }, (_, i) => makeDoc(i)))
    {
      let i = 0
      const r = await bench(() => col.updateOne({ _id: ids[i++ % ids.length] }, { $set: { views: i } }), { maxIters: 300, budgetMs: 3000 })
      row('updateOne (by _id)', 'point update, $set one field', r.median, { unit: 'opsPerSec', iters: r.iters })
    }
    {
      let i = 0
      const r = await bench(() => col.deleteOne({ _id: ids[i++ % ids.length] }), { warmup: 0, maxIters: 300, budgetMs: 3000 })
      row('deleteOne (by _id)', 'point delete', r.median, { unit: 'opsPerSec', iters: r.iters })
    }
  }

  // 2. Queries at 100k documents -------------------------------------------
  {
    const col = new Col(client, 'articles')
    progress(`ingesting ${QUERY_N} documents…`)
    const allIds = []
    const t0 = performance.now()
    for (let i = 0; i < QUERY_N; i += 5000) {
      allIds.push(...await col.insertMany(Array.from({ length: 5000 }, (_, j) => makeDoc(i + j))))
      if (i % 25_000 === 0) progress(`  ${i + 5000}/${QUERY_N}`)
    }
    const ingestMs = performance.now() - t0
    await col.createIndex('userId')
    await col.createIndex('publishedAt')

    section(`Queries — ${QUERY_N.toLocaleString('en-US')} documents`)
    row(`bulk ingest ${QUERY_N / 1000}k docs`, 'insertMany, batches of 5,000', ingestMs, { unit: 'ingest', n: QUERY_N })
    {
      let i = 0
      const r = await bench(() => col.findOne({ _id: allIds[(i += 7919) % QUERY_N] }), { maxIters: 300 })
      row('findOne by _id', 'primary-key point get', r.median, { unit: 'ms', iters: r.iters })
    }
    {
      let i = 0
      const r = await bench(() => col.find({ userId: `user-${(i += 977) % 10_000}` }), { maxIters: 300 })
      row('find, indexed equality', '`userId` (secondary index, ~10 matches)', r.median, { unit: 'ms', iters: r.iters })
    }
    {
      const start = 1_700_000_000_000 + (QUERY_N - 100) * 1000
      const r = await bench(() => col.find({ publishedAt: { $gte: start } }), { maxIters: 300 })
      row('find, indexed range ($gte)', '`publishedAt`, newest ~100 docs', r.median, { unit: 'ms', iters: r.iters })
    }
    {
      let i = 0
      const r = await bench(() => col.find({ title: `Article ${(i += 977) % QUERY_N}: how to configure feature ${((i % QUERY_N) % 97)}` }), { warmup: 1, maxIters: 10, budgetMs: 6000 })
      row('find, unindexed field', `full scan of ${QUERY_N.toLocaleString('en-US')} docs (~1 match)`, r.median, { unit: 'ms', iters: r.iters })
    }
    {
      const r = await bench(() => col.count({ category: 'support' }), { warmup: 1, maxIters: 10, budgetMs: 6000 })
      row('count, unindexed equality', '`category` scan, 12.5k matches', r.median, { unit: 'ms', iters: r.iters })
    }
  }

  // 3. Vector search ---------------------------------------------------------
  // The published @taladb/web binary is flat-only (no vector-hnsw feature),
  // so every findNearest is an exact scan.
  {
    section(`Vector search — ${DIMS}-dim, cosine, top-${TOP_K} (flat index)`)
    for (const N of VECTOR_NS) {
      const col = new Col(client, `vec${N}`)
      await col.createVectorIndex('embedding', DIMS)
      await col.createIndex('locale')
      progress(`ingesting ${N} vectors…`)
      const t0 = performance.now()
      for (let i = 0; i < N; i += 500) {
        const batch = Math.min(500, N - i)
        await col.insertMany(Array.from({ length: batch }, (_, j) => ({ ...makeDoc(i + j), embedding: makeVector(DIMS) })))
      }
      const ingestMs = performance.now() - t0

      const queries = Array.from({ length: 20 }, () => makeVector(DIMS))
      let i = 0
      const r = await bench(() => col.findNearest('embedding', queries[i++ % queries.length], TOP_K), { warmup: 2, maxIters: 40, budgetMs: 5000 })
      row(`findNearest, ${N.toLocaleString('en-US')} vectors`, 'exact k-NN over all vectors', r.median, { unit: 'ms', iters: r.iters })

      if (N === HYBRID_N) {
        let j = 0
        const rh = await bench(() => col.findNearest('embedding', queries[j++ % queries.length], TOP_K, { locale: 'en' }), { warmup: 2, maxIters: 40, budgetMs: 5000 })
        row(`findNearest + filter, ${N.toLocaleString('en-US')} vectors`, 'indexed pre-filter `locale: "en"` (10%), then rank', rh.median, { unit: 'ms', iters: rh.iters })
        row(`vector ingest, ${N.toLocaleString('en-US')} vectors`, 'insertMany with vector index live', ingestMs, { unit: 'ingest', n: N })
      }
    }
  }

  await post('/__bench/result', { ua: navigator.userAgent, opfs, rows })
}

main().catch((e) => post('/__bench/error', { error: String(e?.stack ?? e) }))
