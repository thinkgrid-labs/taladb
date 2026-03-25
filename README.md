<div align="center">

<img src=".github/assets/taladb.svg" alt="TalaDB" width="200" />

**Local-first document database. Zero cloud. Zero GC. Zero compromise.**

[![Status: Active Development](https://img.shields.io/badge/Status-Active%20Development-yellow)](https://github.com/thinkgrid-labs/taladb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-2021_Edition-orange?logo=rust)](https://www.rust-lang.org)
[![WASM](https://img.shields.io/badge/WASM-wasm--bindgen-purple?logo=webassembly)](https://rustwasm.github.io/wasm-bindgen/)
[![Platform](https://img.shields.io/badge/Platform-Browser%20%7C%20React%20Native%20%7C%20Node.js-green)](https://github.com/thinkgrid-labs/taladb)

**[Documentation](https://thinkgrid-labs.github.io/taladb/) · [Web Guide](https://thinkgrid-labs.github.io/taladb/guide/web) · [Node.js Guide](https://thinkgrid-labs.github.io/taladb/guide/node) · [React Native Guide](https://thinkgrid-labs.github.io/taladb/guide/react-native)**

</div>

> [!WARNING]
> **TalaDB is under active development.** APIs may change before a stable release. Not yet recommended for production use.

---

TalaDB is an open-source, **local-first document database** built in Rust. It gives React and React Native developers a MongoDB-like query API (`find`, `insert`, `update`, `delete`, `$eq`, `$gt`, `$in`, `$and`, `$or`) while running entirely on the user's device — no server, no network, no subscriptions.

The same Rust core powers all three runtimes:

| Runtime | Package | Mechanism |
|---|---|---|
| Browser | `taladb-wasm` | `wasm-bindgen` + OPFS via SharedWorker |
| Node.js | `taladb-node` | `napi-rs` native module |
| React Native | `taladb-react-native` | JSI HostObject (C FFI via `cbindgen`) |

Application code uses the unified `taladb` package with a single TypeScript API on every platform.

## Highlights

- **MongoDB-like API** — familiar filter and update DSL, fully typed with TypeScript generics
- **Secondary indexes** — type-safe B-tree indexes with automatic index selection and O(log n) range scans
- **ACID transactions** — powered by [redb](https://github.com/cberner/redb), a pure-Rust B-tree storage engine
- **Full-text search** — inverted token index with `$contains` filter
- **Live queries** — subscribe to a filter and receive snapshots after every write, no polling
- **Encryption at rest** — transparent AES-GCM-256 via `EncryptedBackend`, keys derived with PBKDF2-HMAC-SHA256
- **Schema migrations** — versioned, atomic, run at open time
- **Snapshot export / import** — portable binary format for backup and cross-device sync
- **CLI dev tools** — `taladb inspect`, `export`, `import`, `count`, `drop`

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
wasm-pack test packages/taladb-wasm --headless --chrome
```

### Building

```bash
# Browser WASM
pnpm --filter taladb-wasm build

# Node.js native module
pnpm --filter taladb-node build

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

## Contributors

| Name | Contact |
|---|---|
| Dennis P | [dennis@thinkgrid.dev](mailto:dennis@thinkgrid.dev) |

## License

MIT © [thinkgrid-labs](https://github.com/thinkgrid-labs)

---

<div align="center">

Built with Rust 🦀 · Designed for the local-first web

</div>
