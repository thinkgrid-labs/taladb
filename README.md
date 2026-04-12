<div align="center">

<img src=".github/assets/tala-db-banner.png" alt="TalaDB" width="800" />

**Local-first document + vector database. Zero cloud. Zero GC. Zero compromise.**

[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange)](https://github.com/thinkgrid-labs/taladb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-2021_Edition-orange?logo=rust)](https://www.rust-lang.org)
[![WASM](https://img.shields.io/badge/WASM-wasm--bindgen-purple?logo=webassembly)](https://rustwasm.github.io/wasm-bindgen/)
[![Platform](https://img.shields.io/badge/Platform-Browser%20%7C%20React%20Native%20%7C%20Node.js-green)](https://github.com/thinkgrid-labs/taladb)
[![Sponsor](https://img.shields.io/badge/Sponsor-thinkgrid--labs-red?logo=github-sponsors)](https://github.com/sponsors/thinkgrid-labs)

**[Documentation](https://thinkgrid-labs.github.io/taladb/) · [Live Demo](https://taladb-playground.vercel.app/) · [Web Guide](https://thinkgrid-labs.github.io/taladb/guide/web) · [Node.js Guide](https://thinkgrid-labs.github.io/taladb/guide/node) · [React Native Guide](https://thinkgrid-labs.github.io/taladb/guide/react-native)**

</div>

> [!NOTE]
> **TalaDB is in beta.** Core APIs are stable but may change before v1.0. Not yet recommended for production use.

---

TalaDB is an open-source, **local-first document and vector database** built in Rust. It gives React and React Native developers a MongoDB-like query API alongside on-device vector similarity search — store documents, search embeddings, and combine both in a single query, all running entirely on the user's device with no server, no network, and no cloud subscription.

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
- **Secondary indexes** — type-safe B-tree indexes with automatic index selection and O(log n) range scans
- **ACID transactions** — powered by [redb](https://github.com/cberner/redb), a pure-Rust B-tree storage engine
- **Full-text search** — inverted token index with `$contains` filter
- **Live queries** — subscribe to a filter and receive snapshots after every write, no polling
- **Encryption at rest** — transparent AES-GCM-256 via `EncryptedBackend`, keys derived with PBKDF2-HMAC-SHA256
- **Schema migrations** — versioned, atomic, run at open time
- **Snapshot export / import** — portable binary format for backup and cross-device sync
- **CLI dev tools** — `taladb inspect`, `export`, `import`, `count`, `drop`

## Usage

### Install

```bash
# Browser
pnpm add taladb @taladb/web

# Node.js
pnpm add taladb @taladb/node

# React Native
pnpm add taladb @taladb/react-native
```

### Open a database

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db')  // OPFS in browser, file on Node.js / React Native
```

---

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

### Hybrid search — the killer feature

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

Full documentation is at **[thinkgrid-labs.github.io/taladb](https://thinkgrid-labs.github.io/taladb/)**.

| Section | Link |
|---|---|
| Introduction & architecture | [/introduction](https://thinkgrid-labs.github.io/taladb/introduction) |
| Core concepts | [/concepts](https://thinkgrid-labs.github.io/taladb/concepts) |
| Feature overview | [/features](https://thinkgrid-labs.github.io/taladb/features) |
| Web (Browser / WASM) guide | [/guide/web](https://thinkgrid-labs.github.io/taladb/guide/web) |
| Node.js guide | [/guide/node](https://thinkgrid-labs.github.io/taladb/guide/node) |
| React Native guide | [/guide/react-native](https://thinkgrid-labs.github.io/taladb/guide/react-native) |
| Collection API | [/api/collection](https://thinkgrid-labs.github.io/taladb/api/collection) |
| Filters | [/api/filters](https://thinkgrid-labs.github.io/taladb/api/filters) |
| Updates | [/api/updates](https://thinkgrid-labs.github.io/taladb/api/updates) |
| Migrations | [/api/migrations](https://thinkgrid-labs.github.io/taladb/api/migrations) |
| Encryption | [/api/encryption](https://thinkgrid-labs.github.io/taladb/api/encryption) |
| Live queries | [/api/live-queries](https://thinkgrid-labs.github.io/taladb/api/live-queries) |

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

Contributions are welcome! TalaDB is MIT-licensed and fully open source.

1. Fork the repo and create a branch: `git checkout -b feat/my-feature`
2. Make your changes and add tests
3. Run `cargo test --workspace` and `pnpm --filter taladb test`
4. Open a pull request with a clear description

Please open an issue first for large features or architectural changes.

## Contributing

TalaDB is built by and for the community. Whether you're fixing a bug, adding a new query operator, or improving documentation, your help is welcome!

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and our development workflow.


| Name | Contact |
|---|---|
| Dennis P | [dennis@thinkgrid.dev](mailto:dennis@thinkgrid.dev) |

## License

MIT © [thinkgrid-labs](https://github.com/thinkgrid-labs)

## Sponsors

If you find TalaDB useful, please consider [sponsoring the project](https://github.com/sponsors/thinkgrid-labs). Your support helps me maintain the project and develop new features.


---

<div align="center">

Built with Rust 🦀 · Documents and vectors, on device

</div>
