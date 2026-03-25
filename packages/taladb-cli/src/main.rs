/// TalaDB CLI — dev tools for TalaDB databases.
///
/// Commands:
///   taladb inspect <file>                       — print DB stats
///   taladb export  <file> <collection> [--fmt]  — export to JSON / NDJSON / CSV
///   taladb import  <file> <collection> <data>   — import from JSON / NDJSON
///   taladb collections <file>                   — list all collections
///   taladb count   <file> <collection>          — count documents
///   taladb drop    <file> <collection>          — drop an entire collection

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use taladb_core::{Database, Filter, Value};

// ---------------------------------------------------------------------------
// CLI argument types
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(
    name = "taladb",
    version,
    about = "TalaDB command-line dev tools",
    long_about = "Inspect, export, and import data in TalaDB database files."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print database statistics (collections, document counts, index info).
    Inspect {
        /// Path to the TalaDB database file.
        file: PathBuf,
    },

    /// List all collection names in the database.
    Collections {
        /// Path to the TalaDB database file.
        file: PathBuf,
    },

    /// Count documents in a collection.
    Count {
        /// Path to the TalaDB database file.
        file: PathBuf,
        /// Collection name.
        collection: String,
    },

    /// Export a collection to JSON, NDJSON, or CSV.
    Export {
        /// Path to the TalaDB database file.
        file: PathBuf,
        /// Collection name to export.
        collection: String,
        /// Output format.
        #[arg(long, short, default_value = "json")]
        fmt: ExportFormat,
        /// Output file path. Defaults to stdout.
        #[arg(long, short)]
        out: Option<PathBuf>,
    },

    /// Import documents from a JSON array or NDJSON file into a collection.
    Import {
        /// Path to the TalaDB database file (created if it doesn't exist).
        file: PathBuf,
        /// Collection name to import into.
        collection: String,
        /// Input data file (.json array or .ndjson).
        data: PathBuf,
    },

    /// Delete all documents in a collection (does NOT drop indexes).
    Drop {
        /// Path to the TalaDB database file.
        file: PathBuf,
        /// Collection name to clear.
        collection: String,
    },
}

#[derive(Clone, ValueEnum)]
enum ExportFormat {
    /// Pretty-printed JSON array.
    Json,
    /// Newline-delimited JSON (one document per line).
    Ndjson,
    /// Comma-separated values (flat fields only).
    Csv,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Inspect { file } => cmd_inspect(&file),
        Command::Collections { file } => cmd_collections(&file),
        Command::Count { file, collection } => cmd_count(&file, &collection),
        Command::Export { file, collection, fmt, out } => cmd_export(&file, &collection, fmt, out.as_deref()),
        Command::Import { file, collection, data } => cmd_import(&file, &collection, &data),
        Command::Drop { file, collection } => cmd_drop(&file, &collection),
    }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

fn cmd_inspect(file: &PathBuf) -> Result<()> {
    let db = Database::open(file).with_context(|| format!("opening {:?}", file))?;

    println!("TalaDB Inspector");
    println!("────────────────");
    println!("File: {}", file.display());

    // Collect known collections by scanning doc tables
    // (In a future version, a collection registry table will make this trivial)
    println!("\nNo collection registry yet — use `taladb collections` to list.");
    println!("Use `taladb count <file> <collection>` to count documents.");

    Ok(())
}

// ---------------------------------------------------------------------------
// collections (placeholder — needs collection registry in core)
// ---------------------------------------------------------------------------

fn cmd_collections(file: &PathBuf) -> Result<()> {
    let _db = Database::open(file).with_context(|| format!("opening {:?}", file))?;
    println!("Collection registry is planned for a future release.");
    println!("Known collections must be specified explicitly on the command line.");
    Ok(())
}

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

fn cmd_count(file: &PathBuf, collection: &str) -> Result<()> {
    let db = Database::open(file).with_context(|| format!("opening {:?}", file))?;
    let col = db.collection(collection);
    let n = col.count(Filter::All)?;
    println!("{}", n);
    Ok(())
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

fn cmd_export(
    file: &PathBuf,
    collection: &str,
    fmt: ExportFormat,
    out: Option<&std::path::Path>,
) -> Result<()> {
    let db = Database::open(file).with_context(|| format!("opening {:?}", file))?;
    let col = db.collection(collection);
    let docs = col.find(Filter::All)?;

    let json_docs: Vec<serde_json::Value> = docs
        .iter()
        .map(|doc| {
            let mut map = serde_json::Map::new();
            map.insert("_id".into(), serde_json::Value::String(doc.id.to_string()));
            for (k, v) in &doc.fields {
                map.insert(k.clone(), value_to_json(v));
            }
            serde_json::Value::Object(map)
        })
        .collect();

    let output: String = match fmt {
        ExportFormat::Json => serde_json::to_string_pretty(&json_docs)?,
        ExportFormat::Ndjson => json_docs
            .iter()
            .map(|d| serde_json::to_string(d).unwrap())
            .collect::<Vec<_>>()
            .join("\n"),
        ExportFormat::Csv => {
            if json_docs.is_empty() {
                String::new()
            } else {
                // Collect all field names from the first document
                let headers: Vec<String> = if let serde_json::Value::Object(m) = &json_docs[0] {
                    m.keys().cloned().collect()
                } else {
                    vec![]
                };
                let mut rows = vec![headers.join(",")];
                for doc in &json_docs {
                    if let serde_json::Value::Object(m) = doc {
                        let row: Vec<String> = headers
                            .iter()
                            .map(|h| {
                                m.get(h)
                                    .map(|v| csv_escape(v))
                                    .unwrap_or_default()
                            })
                            .collect();
                        rows.push(row.join(","));
                    }
                }
                rows.join("\n")
            }
        }
    };

    match out {
        Some(path) => std::fs::write(path, &output).with_context(|| format!("writing {:?}", path))?,
        None => println!("{}", output),
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

fn cmd_import(file: &PathBuf, collection: &str, data: &PathBuf) -> Result<()> {
    let db = Database::open(file).with_context(|| format!("opening {:?}", file))?;
    let col = db.collection(collection);

    let content = std::fs::read_to_string(data)
        .with_context(|| format!("reading {:?}", data))?;

    // Detect format: NDJSON (one JSON object per line) vs JSON array
    let docs: Vec<serde_json::Value> = if content.trim_start().starts_with('[') {
        serde_json::from_str(&content)?
    } else {
        content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).map_err(anyhow::Error::from))
            .collect::<Result<Vec<_>>>()?
    };

    let count = docs.len();
    let items: Vec<Vec<(String, Value)>> = docs
        .into_iter()
        .map(|d| {
            if let serde_json::Value::Object(map) = d {
                map.into_iter()
                    .filter(|(k, _)| k != "_id") // skip imported IDs — new ULIDs assigned
                    .map(|(k, v)| (k, json_to_value(v)))
                    .collect()
            } else {
                vec![]
            }
        })
        .collect();

    col.insert_many(items)?;
    eprintln!("Imported {} documents into '{}'", count, collection);
    Ok(())
}

// ---------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------

fn cmd_drop(file: &PathBuf, collection: &str) -> Result<()> {
    let db = Database::open(file).with_context(|| format!("opening {:?}", file))?;
    let col = db.collection(collection);
    let n = col.delete_many(Filter::All)?;
    eprintln!("Deleted {} documents from '{}'", n, collection);
    Ok(())
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

fn value_to_json(v: &Value) -> serde_json::Value {
    match v {
        Value::Null => serde_json::Value::Null,
        Value::Bool(b) => serde_json::Value::Bool(*b),
        Value::Int(n) => serde_json::Value::Number((*n).into()),
        Value::Float(f) => serde_json::Number::from_f64(*f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Str(s) => serde_json::Value::String(s.clone()),
        Value::Bytes(b) => serde_json::Value::String(format!("<bytes:{}>", b.len())),
        Value::Array(arr) => serde_json::Value::Array(arr.iter().map(value_to_json).collect()),
        Value::Object(obj) => serde_json::Value::Object(
            obj.iter().map(|(k, v)| (k.clone(), value_to_json(v))).collect(),
        ),
    }
}

fn json_to_value(j: serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Bool(b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { Value::Int(i) }
            else { Value::Float(n.as_f64().unwrap_or(0.0)) }
        }
        serde_json::Value::String(s) => Value::Str(s),
        serde_json::Value::Array(arr) => Value::Array(arr.into_iter().map(json_to_value).collect()),
        serde_json::Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, json_to_value(v))).collect())
        }
    }
}

fn csv_escape(v: &serde_json::Value) -> String {
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}
