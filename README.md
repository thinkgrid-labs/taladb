<div align="center">

<img src=".github/assets/tala-db-banner.png" alt="TalaDB" width="800" />

**The embedded database for local-first JavaScript apps.**<br/>
Documents + vector search built in Rust — browser, Node.js, and React Native. No cloud. No compromise.

[![npm](https://img.shields.io/npm/v/taladb?label=npm)](https://www.npmjs.com/package/taladb)
[![Status: Stable](https://img.shields.io/badge/Status-Stable-green)](https://github.com/thinkgrid-labs/taladb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-2021_Edition-orange?logo=rust)](https://www.rust-lang.org)
[![WASM](https://img.shields.io/badge/WASM-wasm--bindgen-purple?logo=webassembly)](https://rustwasm.github.io/wasm-bindgen/)
[![Platform](https://img.shields.io/badge/Platform-Browser%20%7C%20React%20Native%20%7C%20Node.js-green)](https://github.com/thinkgrid-labs/taladb)
[![Sponsor](https://img.shields.io/badge/Sponsor-thinkgrid--labs-red?logo=github-sponsors)](https://github.com/sponsors/thinkgrid-labs)

**[Documentation](https://taladb.dev) · [Web Demo](https://taladb-playground.vercel.app/) · [Mobile Demo](https://appetize.io/app/b_ugmjhjghdkgnjux4lzkepvsfma) · [Web Guide](https://taladb.dev/guide/web) · [Node.js Guide](https://taladb.dev/guide/node) · [React Native Guide](https://taladb.dev/guide/react-native)**

</div>


---

Most JavaScript apps require three separate tools to handle structured queries, vector similarity search, and offline-first storage — each with its own API, each requiring a server. TalaDB replaces all three with a single embedded database that runs entirely on the user's device, across every JavaScript runtime.

## Why TalaDB?

|  | TalaDB | RxDB / Dexie | Expo SQLite | LanceDB |
|---|---|---|---|---|
| Runs in browser | ✓ | ✓ | ✗ | ✗ |
| React Native | ✓ | ✗ | ✓ | ✗ |
| On-device vector search | ✓ | ✗ | ✗ | ✓ |
| Unified API across runtimes | ✓ | ✗ | ✗ | ✗ |
| No cloud required | ✓ | ✓ | ✓ | ✗ |
| Rust core | ✓ | ✗ | ✗ | ✓ |

*The only embedded database with vector search that runs on all three JS runtimes with a single API.*

The same Rust core powers all three runtimes:

| Runtime | Package | Mechanism |
|---|---|---|
| Browser | `@taladb/web` | `wasm-bindgen` + OPFS via SharedWorker |
| Node.js | `@taladb/node` | `napi-rs` native module |
| React Native | `@taladb/react-native` | JSI HostObject (C FFI via `cbindgen`) |

Application code uses the unified `taladb` package with a single TypeScript API on every platform.

## Highlights

- **Vector search** — on-device similarity search (cosine, dot, euclidean) with optional metadata pre-filter; pairs naturally with on-device AI models (transformers.js, ONNX Web)
- **Hybrid queries** — combine a regular document filter with vector ranking in one call: find the 5 most semantically similar *english-language support articles* without two round-trips
- **MongoDB-like API** — familiar filter and update DSL, fully typed with TypeScript generics
- **ACID transactions** — powered by [redb](https://github.com/cberner/redb), a pure-Rust B-tree storage engine
- **Live queries** — subscribe to a filter and receive snapshots after every write, no polling

\+ encryption at rest, full-text search, schema migrations, snapshot export/import, CLI tools.

## Performance

Measured with the reproducible suites in [`scripts/`](scripts/) (`pnpm bench:web` for the browser, `pnpm bench` for Node.js) on a **2018 MacBook Pro** (Intel i5-8259U, 8 GB) — deliberately modest hardware; treat these as a floor. TalaDB v0.9.0, file-backed / OPFS, medians after warmup.

**Browser (WASM + OPFS)** — the flagship runtime, measured in headless Chrome (every timing includes the worker round-trip):

| Operation | Scale | Result |
|---|---|---|
| `findOne` by `_id` | 100k docs | **100 µs** |
| `find` on indexed field | 100k docs | **300 µs** |
| Bulk ingest (`insertMany`) | batches of 5k | **~57k docs/s** |
| `findNearest` (384-dim, exact k-NN) | 10k vectors | **35 ms** |
| `findNearest` (384-dim, exact k-NN) | 50k vectors | **170 ms** |
| Hybrid: indexed filter + vector rank | 50k vectors | **162 ms** |

**Node.js (native)** — file-backed, `fsync`-durable per write:

| Operation | Scale | Result |
|---|---|---|
| `findOne` by `_id` | 100k docs | **25 µs** |
| `find` on indexed field | 100k docs | **169 µs** |
| `find`, two-sided range (`$gte`+`$lt`) | 100k docs | **1.4 ms** |
| Bulk ingest (`insertMany`) | batches of 5k | **~36k docs/s** |
| `findNearest` (384-dim, exact k-NN) | 10k / 100k vectors | **18 ms / 198 ms** |
| Hybrid: indexed filter + vector rank | 100k vectors | **346 ms** |

Vector search is exact by default — no approximation, no recall trade-off — with an optional HNSW index on Node.js (93 ms → 15 ms at 50k vectors). The v0.9.0 scan rewrite roughly **halved** flat vector search and turned two-sided range queries into a single bounded index scan (~463 ms → 1.4 ms). Browser vector search currently trails native by ~2× purely for lack of WASM `simd128` — a measured SIMD build closes the gap and is [next up](https://taladb.dev/roadmap). Full tables, methodology, and tuning notes: **[taladb.dev/benchmarks](https://taladb.dev/benchmarks)**.

## Usage

### Install

Every app installs the unified **`taladb`** package plus **one runtime binding** for its platform. Everything else is optional.

**Web app (browser)**

```bash
pnpm add taladb @taladb/web          # required
pnpm add @taladb/react               # optional — React hooks (useFind, useFindOne, …)
```

**Mobile app (React Native / Expo)**

```bash
pnpm add taladb @taladb/react-native # required
pnpm add @taladb/react               # optional — the same hooks work in React Native
```

**Node.js (server / scripts)**

```bash
pnpm add taladb @taladb/node                 # required
pnpm add @taladb/sync-mongodb mongodb        # optional — sync to MongoDB (server-side only)
```

| Package | Web | Mobile (RN) | Node | Role |
|---|:--:|:--:|:--:|---|
| `taladb` | ✅ required | ✅ required | ✅ required | Unified API |
| `@taladb/web` | ✅ required | — | — | Browser WASM binding |
| `@taladb/react-native` | — | ✅ required | — | React Native (JSI) binding |
| `@taladb/node` | — | — | ✅ required | Node.js native binding |
| `@taladb/react` | ⭕ optional | ⭕ optional | — | React / React Native hooks |
| `@taladb/sync-mongodb` | — | — | ⭕ optional | MongoDB sync ([server-side only](https://taladb.dev/guide/bidirectional-sync#mongodb-adapter)) |
| `@taladb/cloudflare` | — | — | ⭕ optional | Cloudflare Workers deploy target |

Bidirectional HTTP sync (`HttpSyncAdapter`) ships inside `taladb` — no extra install. Database sync adapters like `@taladb/sync-mongodb` hold DB credentials and run **server-side only**; a web or mobile app syncs through your own API, never a direct database connection.

### Quick start

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db')  // OPFS in browser, file on Node.js / React Native
```

### As a document database

```ts
interface Article {
  _id?: string
  title: string
  category: string
  locale: string
  publishedAt: number
}

const articles = db.collection<Article>('articles')

// Insert
const id = await articles.insert({
  title: 'How to reset your password',
  category: 'support',
  locale: 'en',
  publishedAt: Date.now(),
})

// Query with filters
const results = await articles.find({
  category: 'support',
  locale: 'en',
  publishedAt: { $gte: Date.now() - 86_400_000 },
})

// Update
await articles.updateOne({ _id: id }, { $set: { title: 'Reset your password' } })

// Delete
await articles.deleteOne({ _id: id })

// Secondary index for fast lookups
await articles.createIndex('category')
await articles.createIndex('publishedAt')
```

---

### As a vector database

```ts
import { pipeline } from '@xenova/transformers'

// Any on-device embedding model works
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
const embed = async (text: string) => {
  const out = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data) as number[]
}

// 1. Create the vector index once (backfills existing documents automatically)
await articles.createVectorIndex('embedding', { dimensions: 384 })

// 2. Insert documents with their embeddings
await articles.insert({
  title: 'How to reset your password',
  category: 'support',
  locale: 'en',
  publishedAt: Date.now(),
  embedding: await embed('How to reset your password'),
})

// 3. Semantic search — find the 5 most similar articles
const query = await embed('forgot my login credentials')
const results = await articles.findNearest('embedding', query, 5)

results.forEach(({ document, score }) => {
  console.log(score.toFixed(3), document.title)
})
// 0.941  How to reset your password
// 0.887  Account recovery options
// 0.823  Two-factor authentication setup
```

---

### Hybrid search — filter then rank

Filter by metadata first, then rank by vector similarity. One call, no extra round-trips.

```ts
// "Find the 5 most relevant english support articles for this query"
const results = await articles.findNearest('embedding', query, 5, {
  category: 'support',
  locale: 'en',
})

// Works across all runtimes — browser, React Native, Node.js
// Data never leaves the device
```

---

### Live queries

```ts
// Subscribe to changes — callback fires after every matching write
const unsub = articles.subscribe({ category: 'support' }, (docs) => {
  console.log('support articles updated:', docs.length)
})

// Stop listening
unsub()
```

## Documentation

Full documentation is at **[taladb.dev](https://taladb.dev)**.

| Section | Link |
|---|---|
| Introduction & architecture | [/introduction](https://taladb.dev/introduction) |
| Core concepts | [/concepts](https://taladb.dev/concepts) |
| Feature overview | [/features](https://taladb.dev/features) |
| Benchmarks | [/benchmarks](https://taladb.dev/benchmarks) |
| Web (Browser / WASM) guide | [/guide/web](https://taladb.dev/guide/web) |
| Node.js guide | [/guide/node](https://taladb.dev/guide/node) |
| React Native guide | [/guide/react-native](https://taladb.dev/guide/react-native) |
| Collection API | [/api/collection](https://taladb.dev/api/collection) |
| Filters | [/api/filters](https://taladb.dev/api/filters) |
| Updates | [/api/updates](https://taladb.dev/api/updates) |
| Migrations | [/api/migrations](https://taladb.dev/api/migrations) |
| Encryption | [/api/encryption](https://taladb.dev/api/encryption) |
| Live queries | [/api/live-queries](https://taladb.dev/api/live-queries) |

## Development

### Prerequisites

- [Rust](https://rustup.rs/) stable 1.75+
- [wasm-pack](https://rustwasm.github.io/wasm-pack/) — for browser builds
- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/) 9+
- `@napi-rs/cli` — for Node.js native module builds

### Running tests

```bash
# Rust unit + integration tests
cargo test --workspace

# TypeScript tests
pnpm --filter taladb test

# Browser WASM tests (requires Chrome)
wasm-pack test packages/@taladb/web --headless --chrome
```

### Building

```bash
# Browser WASM
pnpm --filter @taladb/web build

# Node.js native module
pnpm --filter @taladb/node build

# TypeScript package
pnpm --filter taladb build

# All packages
pnpm build
```

### Local docs

```bash
pnpm docs:dev     # dev server at http://localhost:5173
pnpm docs:build   # production build
pnpm docs:preview # preview production build
```

## Contributing

Bug reports, PRs, and feedback are all welcome.

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes and add tests
3. Run `cargo test --workspace` and `pnpm --filter taladb test`
4. Open a pull request with a clear description

Open an issue before large features or architectural changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development workflow.

Reach out: [dennis@thinkgrid.dev](mailto:dennis@thinkgrid.dev)

## Support TalaDB

TalaDB is free and open-source, maintained by one person. If it saves you time, [sponsoring on GitHub](https://github.com/sponsors/thinkgrid-labs) directly funds continued development: new runtimes, query operators, and performance work.

## License

MIT © [thinkgrid-labs](https://github.com/thinkgrid-labs)

---

<div align="center">

Documents + vectors, on-device. No cloud. · [taladb.dev](https://taladb.dev)

</div>
