# Schema, Versioning & Sync — Standards

This is the canonical guidance for how TalaDB applications should version their
data, evolve their schemas, and stay correct across sync. It is deliberately
opinionated: TalaDB is a **local-first, Last-Write-Wins replica**, and that
architecture dictates *where* strictness helps and *where* it silently corrupts
data.

The one-line rule:

> **Be strict where writes are local and reversible. Be tolerant where writes
> are distributed and irreversible. Version data per-document, never
> per-connection.**

Everything below follows from that.

---

## 1. Three version axes — don't conflate them

"Schema version" means three different things in TalaDB. A standard that treats
them as one thing will be wrong about at least two of them.

| Axis | Versions… | Owner | Mechanism | Strictness |
| --- | --- | --- | --- | --- |
| **Engine / storage** | internal key/index encoding | TalaDB core | `CURRENT_SCHEMA_VERSION` + `BUILTIN_MIGRATIONS`, auto-run at open | **Strict, automatic** — not your concern |
| **App / device** | your collection shapes on *this* device | Your app | migrations run once at open, over docs present then | **Strict** |
| **Document (`_v`)** | one document's shape, as it travels between peers | Your app | per-doc `_v` tag + import-/read-time normalization | **Tolerant** |

- The **engine axis** is already handled for you — migrations run on every
  `open*` before the handle is returned. You never write these.
- The **app/device axis** is the classic RxDB/Realm "migrate at open" model. It
  only sees documents already on the device — it cannot see documents that
  arrive *later* via sync.
- The **document axis (`_v`)** is the one that matters for sync, because a
  synced document outlives the migration that ran at open. This is where most
  of the discipline below lives.

---

## 2. Strict at the local write boundary

At the boundaries you fully control, enforce hard. It's cheap, synchronous, and
has no distributed-systems failure mode.

**TypeScript types, end to end.** Type every collection and never `as T` at a
boundary:

```ts
import { z } from 'zod';

const User = z.object({ name: z.string(), age: z.number().int(), _v: z.literal(1) });
type User = z.infer<typeof User>;

const users = db.collection<User>('users', { schema: User });
```

**Validate on `insert` / `insertMany` — hard-fail.** With a `schema` attached,
every inserted document is run through `schema.parse()` and a
`TalaDbValidationError` is thrown on failure. Keep this strict: the write is
local and the caller is right there to handle the error.

**Consider `validateOnRead` in development** to catch schema drift on old local
data early. Leave it off in production hot paths.

> **Standard:** every synced collection has a typed schema and a `_v` literal.
> Local writes hard-fail on validation. No `as T` casts anywhere.

---

## 3. Tolerant at the sync-import boundary

Sync import is the boundary you **do not** control — the peer may run an older
or newer version of your app. A local-first LWW engine must **never hard-reject
on import**. Here is exactly why, in terms of TalaDB's own merge rules:

1. **LWW convergence requires deterministic, unconditional application.** If a
   replica rejects a document because it fails the *local* schema, two replicas
   on different versions permanently diverge. That's a correctness break, not a
   dropped write.
2. **You don't control the peer's version.** Hard-rejecting a legitimately
   *newer* remote document is silent **data loss**.
3. **A reject inside a pull batch can wedge the cursor** and poison the replica.

So the import path is tolerant by construction. Its only decisions are:

- **Accept** — store as received (subject to LWW).
- **Coerce** — normalize first (run a `_v` migration, fill defaults), then store.
- **Skip** — a collection this client doesn't model; drop quietly.
- **Quarantine** — set aside in a per-collection quarantine table with a reason,
  recoverable later. **Never** dropped on the floor, **never** aborts the batch.

### The `ImportValidator` hook (core)

As of the tolerant-import work, core `sync` enforces "validate, never cast"
*inside* `import_changes` — not only at the React-hook layer. Attach a validator
that carries your policy (schema parse + `_v` migration); core carries only the
mechanism.

```rust
use std::sync::Arc;
use taladb_core::{Database, ImportDecision, ImportValidator};
use taladb_core::document::{Document, Value};

struct AppValidator;

impl ImportValidator for AppValidator {
    fn check(&self, collection: &str, doc: &Document) -> ImportDecision {
        if collection == "logs" {
            return ImportDecision::Skip; // not modelled on this client
        }
        // Upgrade a below-current shape rather than rejecting it.
        if matches!(doc.get("_v"), Some(Value::Int(0)) | None) {
            let mut up = doc.clone();
            up.set("_v", Value::Int(1));
            return ImportDecision::Coerce(up);
        }
        match doc.get("name").and_then(|v| v.as_str()) {
            Some(n) if !n.is_empty() => ImportDecision::Accept,
            _ => ImportDecision::Quarantine("missing required `name`".into()),
        }
    }
}

let report = db.import_changes_validated(changeset, Arc::new(AppValidator))?;
// report.applied / report.skipped / report.quarantined
let held = db.quarantined("users")?; // inspect & recover rejects
```

The validator **must be deterministic and side-effect free** — the same
document must reach the same decision on every replica, or you reintroduce
divergence. This is the same contract LWW already relies on.

### From JavaScript — `syncSchema` (browser + Node)

App developers don't implement the Rust trait directly. Attach a tolerant
`syncSchema` to the collection; `db.sync()` then validates every pulled document
through it in the core, quarantining bad shapes and upgrading below-`version`
docs — "validate, never cast" inside `db.sync()`, not only in the React hooks:

```ts
const users = db.collection<User>('users', {
  schema: User,                       // strict, on local insert (Zod/Valibot)
  syncSchema: {                       // tolerant, on sync import
    version: 2,
    required: ['email'],
    types: { email: 'str', age: 'int' },
    defaults: { age: 0 },             // filled when upgrading a below-v2 doc
    renames: { mail: 'email' },       // structural rename on upgrade
  },
});

const res = await db.sync(adapter, { collections: ['users'] });
// res.pulled / res.skipped / res.quarantined
const bad = await db.quarantined!('users'); // [{ document, reason, changedAt }]
```

> **Standard:** sync import validates but never hard-rejects. Unknown shapes are
> coerced or quarantined, never dropped or thrown. `db.import_changes` /
> `importChanges` (no validator) remains the unvalidated fast path and is
> unchanged. Wired on browser + Node; React Native falls back to unvalidated
> import until its binding carries the plumbing.

### Read-time normalization — `migrateDocument`

`syncSchema` is *structural* and runs at the *import* boundary. For evolution
that needs computation (derived fields, splits/merges) or that must cover
documents already stored locally, add a lazy **read-time** `migrateDocument` —
the arbitrary-JS complement, applied to what `find`/`findOne` return. Because
reads hand back decoded documents, this is a pure client transform and runs on
**every runtime** with no binding support:

```ts
const users = db.collection<User>('users', {
  syncSchema: { version: 2 },        // supplies the migration target
  migrateDocument: (doc, fromVersion) =>
    fromVersion < 2
      ? { ...doc, fullName: `${doc.first} ${doc.last}` } // computed field
      : doc,
});
// find()/findOne() upgrade any doc whose `_v` < 2 and stamp `_v = 2` before you see it.
```

By default `migrateDocument` transforms the *returned* value only. To make a
lazy migration permanent, set `persistMigrations: true` — an upgraded document
is then written back to storage (a best-effort `$set`/`$unset` diff), after
which filters and indexes on the new shape match it:

```ts
db.collection<User>('users', {
  syncSchema: { version: 2 },
  migrateDocument: (doc, from) => (from < 2 ? { ...doc, fullName: `${doc.first} ${doc.last}` } : doc),
  persistMigrations: true, // write the upgrade back the first time each doc is read
});
```

> **Standard:** three layers, use the narrowest that fits. `openDB({ migrations })`
> rewrites local docs eagerly at open; `syncSchema` (+ `renames`/`defaults`)
> normalizes synced docs eagerly at import; `migrateDocument` normalizes lazily
> at read as the arbitrary-JS catch-all. A lazy migration is view-only unless
> `persistMigrations: true` writes it back — that write fires live-query and
> sync notifications like any other, so prefer an eager `openDB({ migrations })`
> sweep when you want to migrate the whole collection at once.

---

## 4. Version travels with the data, not the connection

A tempting but **wrong** rule: "make the push/pull endpoint reject a peer whose
`db_version` doesn't match mine." That is a *client-server* primitive. TalaDB is
a peer replica; peers legitimately differ in version during any rollout — that's
the normal steady state, not a fault.

The correct primitive is per-document `_v` + import-time normalization:

- Tag every document with `_v` so its shape is **self-describing** across peers.
- On import/read, upgrade a below-current document via a `migrateDocument(doc,
  fromVersion)` step (the `Coerce` path above).
- The endpoint never gates on version equality.

> **Standard:** never gate sync on connection-level version equality. Put the
> version in the document and normalize on the way in.

---

## 5. Additive-only evolution (the discipline that keeps LWW safe)

Until per-document `_v` + `migrateDocument` are fully wired through every client,
and as a permanent good habit for synced collections:

**Only ever add optional fields. Never rename, remove, or retype a field in
place.**

- Adding an optional field is safe: old peers ignore it, new peers default it.
- Renaming = old peers keep writing the old name; you now have two fields.
- Removing = old peers resurrect it on their next write (LWW).
- Retyping = filter/index encoding mismatches and coercion ambiguity.

To rename or retype, do it as **add-new + backfill + dual-read + retire**, never
an in-place mutation, and let the **origin be the canonical-shape gate**
(origin-authoritative write authority — the default in scoped replication).

> **Standard:** synced-collection schema changes are additive-only. Structural
> changes go through add → backfill → dual-read → retire, gated at the origin.

---

## 6. Checklist

Adopt these as review gates for any synced collection:

- [ ] Collection has a typed schema (`z.object(...)`/Valibot) and a `_v` literal.
- [ ] `db.collection(name, { schema })` is set — local writes hard-fail validation.
- [ ] No `as T` cast at any data boundary (insert, read, or import).
- [ ] Import uses a validator; unknown/old shapes are coerced or quarantined.
- [ ] The validator is deterministic and side-effect free.
- [ ] No sync path gates on connection-level `db_version` equality.
- [ ] Schema changes to synced collections are additive-only (or add→backfill→retire).
- [ ] Quarantine counts are monitored (`report.quarantined`, `db.quarantined()`).

---

## Why not "just be strict everywhere"?

Because a local-first LWW engine that hard-rejects on import isn't stricter — it
is **incorrect**. It loses newer writes and diverges replicas. Strictness is a
virtue exactly up to the boundary you control (local writes, types) and a bug
past it (foreign data over the wire). This document draws that line so the
"strict vs flexible" question stops being a global toggle and becomes a
per-boundary decision.
