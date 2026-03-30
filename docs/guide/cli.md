---
title: CLI Dev Tools
description: Inspect, export, import, and manage TalaDB database files from the terminal using the taladb CLI.
---

# CLI Dev Tools

The `taladb` CLI lets you inspect, export, and manage TalaDB database files from the terminal — useful for debugging, data migration, and CI pipelines.

## Installation

Download the pre-built binary for your platform from the [GitHub Releases page](https://github.com/thinkgrid-labs/taladb/releases).

::: code-group

```sh [Linux]
# Download and extract (replace VERSION with the latest release, e.g. v0.1.1)
curl -L https://github.com/thinkgrid-labs/taladb/releases/download/VERSION/taladb-linux-x86_64-VERSION.tar.gz \
  | tar -xz
sudo mv taladb /usr/local/bin/
taladb --version
```

```sh [macOS]
curl -L https://github.com/thinkgrid-labs/taladb/releases/download/VERSION/taladb-macos-aarch64-VERSION.tar.gz \
  | tar -xz
sudo mv taladb /usr/local/bin/
taladb --version
```

```powershell [Windows]
# Download taladb-windows-x86_64-VERSION.zip from the releases page,
# extract it, and add the folder to your PATH.
taladb --version
```

:::

## Commands

### `inspect` — database overview

Print all collections and their document counts.

```sh
taladb inspect ./myapp.db
```

```
TalaDB Inspector
────────────────
File: myapp.db

Collections (3):
  products  (142 documents)
  sessions  (8 documents)
  users     (56 documents)
```

---

### `collections` — list collection names

Print one collection name per line (useful for scripting).

```sh
taladb collections ./myapp.db
```

---

### `count` — count documents

```sh
taladb count ./myapp.db users
# 56
```

---

### `export` — dump a collection

Export all documents in a collection to JSON, NDJSON, or CSV.

```sh
# Pretty-printed JSON array (default) — prints to stdout
taladb export ./myapp.db users

# Write to a file
taladb export ./myapp.db users --out users.json

# Newline-delimited JSON (one document per line)
taladb export ./myapp.db users --fmt ndjson --out users.ndjson

# CSV (flat fields only)
taladb export ./myapp.db users --fmt csv --out users.csv
```

**Flags**

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--fmt` | `-f` | `json` | Output format: `json`, `ndjson`, `csv` |
| `--out` | `-o` | stdout | Output file path |

---

### `import` — bulk insert from JSON / NDJSON

Import documents from a JSON array file or NDJSON file. New ULIDs are assigned — any `_id` fields in the source are ignored.

```sh
# From a JSON array
taladb import ./myapp.db users users.json

# From NDJSON
taladb import ./myapp.db users users.ndjson
```

The database file is created if it does not exist.

---

### `drop` — clear a collection

Delete all documents in a collection. Indexes defined on the collection are preserved.

```sh
taladb drop ./myapp.db sessions
# Deleted 8 documents from 'sessions'
```

---

## Common workflows

**Back up a collection before a migration:**

```sh
taladb export ./prod.db users --out users-backup.json
```

**Seed a local dev database from production export:**

```sh
taladb import ./dev.db users users-backup.json
```

**Check document counts in CI:**

```sh
COUNT=$(taladb count ./test.db results)
if [ "$COUNT" -lt 1 ]; then
  echo "No results written — test failed"
  exit 1
fi
```
