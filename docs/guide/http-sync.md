---
title: HTTP Push Sync
description: Fire-and-forget HTTP events on every local mutation. Push inserts, updates, and deletes to any REST endpoint — webhook receivers, analytics pipelines, audit logs, or cloud sync backends.
---

# HTTP Push Sync

HTTP push sync fires a background HTTP POST to a configured endpoint after every successful write — insert, update, or delete. No infrastructure is required on TalaDB's side. Works with any existing REST API, webhook receiver, or event pipeline.

::: info Platform support
HTTP push sync is available on **Node.js**, **browser (WASM)**, and **React Native**. On Node.js, config is auto-discovered from a `taladb.config.yml` file or passed inline to `openDB`. On browser and React Native, config is passed at open time (see the platform-specific guides). On all platforms, sync is best-effort and never blocks writes.
:::

## How it works

After every committed write, TalaDB:

1. Builds a JSON payload describing the mutation (see [Payload format](#payload-format))
2. Spawns a background OS thread
3. POSTs the payload to the configured endpoint with up to **3 retries** and exponential backoff (200 ms / 400 ms / 800 ms)

The spawned thread is completely detached from the write path. **No transaction is ever delayed or blocked by sync.** If the endpoint is unreachable after all retries, the failure is silently dropped — sync is best-effort by design.

## Quick start

Create a config file in your project root:

```yaml
# taladb.config.yml
sync:
  enabled: true
  endpoint: "https://api.example.com/taladb-events"
  headers:
    Authorization: "Bearer YOUR_TOKEN"
```

Then open the database normally — TalaDB auto-discovers the config file from `process.cwd()`:

```ts
import { openDB } from 'taladb'

const db = await openDB('./myapp.db')
// Every write now fires an HTTP event in the background
const users = db.collection('users')
await users.insert({ name: 'Alice', role: 'admin' })
```

You can also pass config inline — useful for tests or dynamic tokens:

```ts
const db = await openDB('./myapp.db', {
  config: {
    sync: {
      enabled: true,
      endpoint: 'https://api.example.com/taladb-events',
      headers: { Authorization: `Bearer ${process.env.SYNC_TOKEN}` },
    },
  },
})
```

## Payload format

Every POST body is a JSON object. The `_taladb_event` field identifies the mutation type.

### `insert`

```json
{
  "_taladb_event": "insert",
  "collection": "users",
  "id": "01HWZZQ0000000000000000000",
  "document": {
    "name": "Alice",
    "role": "admin"
  },
  "timestamp": 1720000000000
}
```

The full document is sent, minus any [excluded fields](#exclude_fields).

### `update`

```json
{
  "_taladb_event": "update",
  "collection": "users",
  "id": "01HWZZQ0000000000000000000",
  "changes": {
    "role": "superadmin",
    "last_seen": 1720000050000
  },
  "timestamp": 1720000050000
}
```

Only the **changed fields** are sent — not the full document. A field set to `null` in `changes` means it was removed from the document.

### `delete`

```json
{
  "_taladb_event": "delete",
  "collection": "users",
  "id": "01HWZZQ0000000000000000000",
  "timestamp": 1720000100000
}
```

`timestamp` is milliseconds since Unix epoch (wall clock of the writing machine).

## Configuration reference

All options live under the `sync` key in `taladb.config.yml` or `taladb.config.json` (Node.js), or in the config object passed to `openDB` / `TalaDBModule.initialize` (browser and React Native).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `false` | Master switch. Nothing is sent when `false`. |
| `endpoint` | `string` | — | Default URL that receives all events. Required when `enabled: true`. Must start with `http://` or `https://`. |
| `headers` | `Record<string, string>` | `{}` | HTTP headers added to every request — use for auth tokens, API keys, etc. |
| `insert_endpoint` | `string` | — | Override endpoint for `insert` events only. Falls back to `endpoint` when omitted. |
| `update_endpoint` | `string` | — | Override endpoint for `update` events only. |
| `delete_endpoint` | `string` | — | Override endpoint for `delete` events only. |
| `exclude_fields` | `string[]` | `[]` | Document fields to **omit** from every payload. Use this to strip large computed fields such as embedding vectors. See [Excluding fields](#excluding-fields). |

### Full example

```yaml
# taladb.config.yml
sync:
  enabled: true

  # Catch-all endpoint
  endpoint: "https://api.example.com/events"

  # Auth header
  headers:
    Authorization: "Bearer my-secret-token"
    X-App-Version: "2.1.0"

  # Per-event endpoint overrides (all fall back to `endpoint` if omitted)
  insert_endpoint: "https://api.example.com/events/insert"
  update_endpoint: "https://api.example.com/events/update"
  delete_endpoint: "https://api.example.com/events/delete"

  # Strip large fields from the payload
  exclude_fields:
    - embedding
    - clip_vector
```

## Excluding fields

By default the full document is serialised into the `insert` payload, and all changed fields appear in `update` payloads. If your documents contain large computed fields — embedding vectors, pre-rendered HTML, base64-encoded thumbnails — those will be included unless explicitly excluded.

```yaml
sync:
  enabled: true
  endpoint: "https://api.example.com/events"
  exclude_fields:
    - embedding      # 1536 floats ≈ 12 KB per document
    - clip_vector
    - rendered_html
```

Rules:
- Excluded fields are stripped **at serialisation time** — the local database is not affected.
- Applies to both `insert` payloads (full document) and `update` payloads (changes map).
- Fields listed but not present in the document are silently ignored.
- `delete` payloads contain only `id` and `timestamp` — `exclude_fields` has no effect on them.

## Config file discovery

On Node.js, TalaDB searches for a config file in this order:

1. `taladb.config.yml` in `process.cwd()`
2. `taladb.config.yaml` in `process.cwd()`
3. `taladb.config.json` in `process.cwd()`

The first match wins. If no file is found, sync is disabled and the database opens normally.

Pass an explicit path to skip discovery:

```ts
const db = await openDB('./myapp.db', {
  configPath: '/etc/myapp/taladb.config.yml',
})
```

## Retry behaviour

| Attempt | Delay before attempt |
|---------|----------------------|
| 1st | Immediate |
| 2nd | 200 ms |
| 3rd | 400 ms |
| 4th | 800 ms |

- **5xx responses and network errors** — retried up to 3 times.
- **4xx responses** — treated as permanent failures; no retry.
- **Success (2xx)** — background thread exits immediately.
- **All retries exhausted** — failure is silently dropped. Write transactions are never affected.

## Full-push via CLI

The `taladb sync` command pushes the current state of the entire database (or a single collection) to the configured endpoint. Useful for seeding a remote from local state or recovering after a sync outage.

```sh
# Push all collections
taladb sync ./myapp.db

# Push a single collection
taladb sync ./myapp.db articles

# Preview events without sending
taladb sync ./myapp.db articles --dry-run

# Use an explicit config file
taladb sync ./myapp.db --config ./config/taladb.prod.yml
```

Every document is sent as an `insert` event — the same JSON shape as the real-time hook. `exclude_fields` from the config is respected.

Progress is printed to stderr:

```
Syncing articles... 142/142 ✓
Syncing users... 56/56 ✓
Done. 198 event(s) sent.
```

See the [CLI docs](/guide/cli#sync-push-entire-database) for the full flag reference.

## Limitations

- **Best-effort delivery.** There is no persistent queue. If the process exits mid-sync, in-flight background threads are lost. Events fired during a network outage are not replayed after reconnection.
- **No ordering guarantee across collections.** Events within a single collection are fired in write order, but there is no ordering guarantee between different collections when writes interleave.
- **No deduplication.** If a write is retried and the remote endpoint is not idempotent, duplicate events may be received. Design your endpoint to be idempotent (e.g. upsert by `id`).
- **Wall-clock timestamps.** `timestamp` reflects the local machine clock. Clocks on different devices may drift. Do not use `timestamp` as a strong ordering guarantee across devices — use the ULID `id` instead, which encodes a monotonic millisecond timestamp.
- **React Native / browser delivery.** On React Native, events are fired via the same Rust background thread as Node.js. In the browser, events are fired via `fetch` on the JS microtask queue — they are subject to the same tab-lifetime constraints as any `fetch` call (e.g. a tab closed mid-retry will lose in-flight events).
- **Embedding vectors.** By default, embedding vectors stored in document fields are included in the payload. Use `exclude_fields` to strip them — see [Excluding fields](#excluding-fields).

## Receiving events

Your endpoint receives standard HTTP POST requests with `Content-Type: application/json`. No TalaDB-specific SDK is required on the receiving side — parse the JSON body and handle the `_taladb_event` field.

### Express example

```ts
import express from 'express'

const app = express().use(express.json())

app.post('/taladb-events', (req, res) => {
  const { _taladb_event, collection, id, document, changes, timestamp } = req.body

  switch (_taladb_event) {
    case 'insert':
      console.log(`New ${collection} document ${id}:`, document)
      break
    case 'update':
      console.log(`Updated ${collection}/${id}:`, changes)
      break
    case 'delete':
      console.log(`Deleted ${collection}/${id}`)
      break
  }

  res.sendStatus(200)
})

app.listen(3000)
```

### Webhook security

Use the `headers` config to pass a shared secret or bearer token:

```yaml
headers:
  Authorization: "Bearer YOUR_SECRET"
```

Verify it on the receiving side before processing the event. TalaDB does not sign payloads — authentication is entirely via the headers you configure.
