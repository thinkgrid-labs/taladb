---
title: CRDT Sync
description: Conflict-free multi-device sync using per-field LWW-registers and grow-only sets. Multiple devices write the same document concurrently without conflicts — independent field changes are always preserved.
---

# CRDT Sync

CRDT sync lets multiple devices write to the same document at the same time without conflicts. Unlike [HTTP Push Sync](/guide/http-sync), which fires one-way events, CRDT sync provides a bidirectional merge strategy: each device can export its local changes and import a peer's changes, and the result is always the same regardless of which order the merges happen.

::: info Where this lives
`CrdtSyncAdapter` is part of `taladb-core`. It sits above the storage engine and works through the same `Collection` API used everywhere else — no schema changes, no new tables.
:::

## The problem it solves

Standard Last-Write-Wins (LWW) resolves document conflicts by picking the version with the highest timestamp. That works when only one field changes, but silently discards data when two devices independently modify *different* fields of the same document:

```
Device A sets  title = "Hello"   at t=100
Device B sets  price = 99        at t=100

LWW picks one whole document → the other device's change is lost
```

CRDT sync tracks a logical clock **per field**, so each field is merged independently:

```
Device A sets  title = "Hello"   { ts: 100, node: "A" }
Device B sets  price = 99        { ts: 100, node: "B" }

After merge → title = "Hello"  AND  price = 99  ✓
```

## How it works

Every field in a CRDT-tracked document carries a logical clock stored under the hidden `_crdt_clocks` field:

```
_crdt_clocks: {
  title: { t: 1720000100000, n: "device-alice" },
  price: { t: 1720000200000, n: "device-bob" }
}
```

When two replicas sync, `import_crdt_changes` merges at field granularity:

- **Remote field is newer** → remote value overwrites local
- **Remote field is older** → local value is kept, remote ignored
- **Same timestamp** → higher `node_id` wins (deterministic tiebreaker, no coordination needed)
- **Different fields** → both survive, always

## Quick start

```rust
use taladb_core::{CrdtSyncAdapter, Database, Value};

let db = Database::open_in_memory()?;
let col = db.collection("docs")?;

// Create an adapter for this device
let adapter = CrdtSyncAdapter::new("device-alice");

// Stamp fields before inserting — records a per-field clock
let fields = adapter.stamp_insert(vec![
    ("title".into(), Value::Str("Hello".into())),
    ("price".into(), Value::Int(99)),
]);
let id = col.insert(fields)?;
```

## Writing documents

### Insert

Call `stamp_insert` before passing fields to `col.insert`. It adds `_crdt_clocks` and `_changed_at` automatically:

```rust
let fields = adapter.stamp_insert(vec![
    ("title".into(), Value::Str("My Document".into())),
    ("status".into(), Value::Str("draft".into())),
    ("count".into(), Value::Int(0)),
]);
col.insert(fields)?;
```

### Update

For field updates, use `adapter.update_fields` instead of the standard `col.update_one`. It loads the document, advances the clocks for the changed fields only, and writes back atomically:

```rust
// Only `status` gets a new clock — `title` and `count` are untouched
adapter.update_fields(&col, doc_id, vec![
    ("status".into(), Value::Str("published".into())),
])?;
```

::: tip Why not `col.update_one`?
`col.update_one` doesn't know which fields you changed or when. Using `adapter.update_fields` is required for CRDT tracking — it records a new clock only for the fields you actually write.
:::

## Syncing between devices

### Export changes

```rust
// Export everything that changed since `last_sync_ms`
// Pass 0 to export the full database state
let outgoing = adapter.export_crdt_changes(&db, &["docs", "tasks"], last_sync_ms)?;

// `outgoing` is a Vec<CrdtChange> — serialize it however you like
let bytes = postcard::to_allocvec(&outgoing)?;
```

### Import changes

```rust
// Deserialize the changeset received from a peer
let peer_changes: CrdtChangeset = postcard::from_bytes(&received_bytes)?;

let applied = adapter.import_crdt_changes(&db, peer_changes)?;
println!("{applied} documents updated");
```

`import_crdt_changes` merges every incoming field mutation against the local document. Only fields where the remote clock wins are written. Documents not touched by the changeset are left completely alone.

### Full round-trip example

```rust
// --- Device A ---
let adapter_a = CrdtSyncAdapter::new("device-a");
let db_a = Database::open("device_a.db")?;

// A writes title
let fields = adapter_a.stamp_insert(vec![
    ("title".into(), Value::Str("Shared doc".into())),
]);
let doc_id = /* same ULID on both devices */;
db_a.collection("docs")?.insert_with_id(Document::with_id(doc_id, fields))?;

// --- Device B ---
let adapter_b = CrdtSyncAdapter::new("device-b");
let db_b = Database::open("device_b.db")?;

// B writes price on the same document
adapter_b.update_fields(&db_b.collection("docs")?, doc_id, vec![
    ("price".into(), Value::Int(49)),
])?;

// --- Sync ---
// B exports its changes and sends to A
let b_changes = adapter_b.export_crdt_changes(&db_b, &["docs"], 0)?;
adapter_a.import_crdt_changes(&db_a, b_changes)?;

// A exports its changes and sends to B
let a_changes = adapter_a.export_crdt_changes(&db_a, &["docs"], 0)?;
adapter_b.import_crdt_changes(&db_b, a_changes)?;

// Both devices now have: title = "Shared doc"  AND  price = 49
```

## Conflict resolution rules

| Scenario | Result |
|---|---|
| Devices write different fields | Both fields survive |
| Same field, remote newer (`ts_ms` higher) | Remote wins |
| Same field, remote older | Local wins, remote ignored |
| Same field, same timestamp, higher `node_id` | Higher `node_id` wins |
| Remote deletes, local doc is newer | Local survives |
| Remote deletes, local doc is older | Doc is deleted |

Deletions are propagated as tombstones — the same mechanism used by `LastWriteWins` — so a deleted document is never resurrected by a stale peer import.

## Grow-only sets (G-Set) for arrays

By default all fields use LWW-register semantics. Array fields can optionally be configured as **grow-only sets**: elements are merged by union across replicas and can never be removed. This avoids the lost-add anomaly when two devices concurrently push to the same array.

```rust
let adapter = CrdtSyncAdapter::new("device-alice")
    .with_g_set_fields(["tags", "collaborators"]);
```

With G-Set configured for `tags`:

```
Device A adds  tags = ["rust"]        at t=100
Device B adds  tags = ["rust", "wasm"] at t=50  ← older clock

After merge →  tags = ["rust", "wasm"]  (union, both survive)
```

Compare with LWW: the older remote value would have been ignored entirely, losing `"wasm"`.

::: warning G-Set semantics
G-Set fields only grow — elements added by any replica are never removed. This is the correct semantics for things like tag lists, collaborator sets, or audit trails. Do not use it for fields where removal is meaningful.
:::

## Node IDs

A `node_id` is any stable string that uniquely identifies a device or replica. Good choices:

```rust
// UUID from device storage
let adapter = CrdtSyncAdapter::new("f47ac10b-58cc-4372-a567-0e02b2c3d479");

// User + device combo
let adapter = CrdtSyncAdapter::new("user_42:iphone-15");

// Human-readable for dev/test
let adapter = CrdtSyncAdapter::new("alice-laptop");
```

The only requirement: two replicas that should **not** share wins must have different `node_id` values. If two replicas share the same `node_id`, their clocks are directly comparable and the higher timestamp always wins (no tiebreaking needed).

## Coexistence with LastWriteWins

`CrdtSyncAdapter` and `LastWriteWins` write to the same database and can coexist. Both use `_changed_at` for export filtering, so you can mix strategies across different collections:

```rust
// Use CRDT for collaborative documents
let crdt = CrdtSyncAdapter::new("device-a");
let crdt_changes = crdt.export_crdt_changes(&db, &["docs"], since_ms)?;

// Use LWW for append-only event logs
let lww = LastWriteWins::new();
let lww_changes = lww.export_changes(&db, &["events"], since_ms)?;
```

## Internal metadata

`CrdtSyncAdapter` stores one hidden field in each document:

| Field | Type | Purpose |
|---|---|---|
| `_crdt_clocks` | `Object` | Per-field logical clocks — `{ field: { t: ms, n: node_id } }` |
| `_changed_at` | `Int` | Highest field clock timestamp — used by the export range scan |

These fields are visible if you read a raw document. Filter them out in your application layer if you don't want to expose them to users:

```rust
let doc = col.find_by_id(id)?.unwrap();
let visible: Vec<_> = doc.fields.iter()
    .filter(|(k, _)| !k.starts_with('_'))
    .collect();
```

## Limitations

- **Wall-clock timestamps.** Clocks on different devices may drift. A device with a significantly wrong clock will lose conflicts it shouldn't. For most apps, NTP-synchronised system clocks (± a few seconds) are fine — logical clocks are only compared in millisecond resolution.
- **No partial-object merge inside nested fields.** CRDT merge works at the top-level field granularity. If a field is a nested object (`Value::Object`), the whole object is LWW — there is no recursive per-key merge inside it.
- **G-Set cannot shrink.** Once an element is added to a G-Set field on any replica, it is permanent. This is by design — G-Sets are CRDTs precisely because they never need to agree on removals.
- **Changeset size grows with document count.** `export_crdt_changes` exports one `CrdtChange` per modified document. For large databases, consider exporting per-collection and streaming.
