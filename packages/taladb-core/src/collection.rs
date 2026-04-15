use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ulid::Ulid;

use crate::aggregate::{execute_pipeline, Stage};
use crate::document::{Document, Value};
use crate::engine::StorageBackend;
use crate::error::TalaDbError;
use crate::fts::{encode_fts_key, fts_table_name, tokenize, FtsDef};
use crate::index::{
    compound_meta_key, compound_table_name, docs_table_name, encode_compound_key, encode_index_key,
    index_table_name, meta_key, tomb_table_name, CompoundIndexDef, IndexDef, META_COMPOUND_TABLE,
    META_INDEXES_TABLE,
};
use crate::query::executor::execute;
use crate::query::filter::Filter;
use crate::query::options::{project_document, sort_documents, FindOptions};
use crate::query::planner::plan_full;
use crate::sync::{now_ms, SyncEvent, SyncHook};
#[cfg(feature = "vector-hnsw")]
use crate::vector::{build_hnsw, search_hnsw, SharedHnswCache};
use crate::vector::{
    compute_similarity, decode_f32_vec, encode_f32_vec, value_to_f32_vec, vec_meta_key,
    vec_table_name, HnswOptions, VectorDef, VectorMetric, VectorSearchResult, META_HNSW_TABLE,
    META_VECTOR_TABLE,
};

const META_FTS_TABLE: &str = "meta::fts_indexes";

struct CachedIndexes {
    indexes: Vec<IndexDef>,
    fts_indexes: Vec<FtsDef>,
    vec_indexes: Vec<VectorDef>,
    compound_indexes: Vec<CompoundIndexDef>,
}

/// An update operation on a document.
#[derive(Debug, Clone)]
pub struct CollectionIndexInfo {
    pub btree: Vec<String>,
    pub fts: Vec<String>,
    pub vector: Vec<String>,
}

#[derive(Clone)]
pub enum Update {
    /// $set — set or replace field values
    Set(Vec<(String, Value)>),
    /// $unset — remove fields
    Unset(Vec<String>),
    /// $inc — increment numeric fields
    Inc(Vec<(String, Value)>),
    /// $push — append a value to an array field
    Push(String, Value),
    /// $pull — remove a value from an array field
    Pull(String, Value),
}

pub struct Collection {
    pub(crate) name: String,
    backend: Arc<dyn StorageBackend>,
    index_cache: Mutex<Option<CachedIndexes>>,
    sync_hook: Option<Arc<dyn SyncHook>>,
    #[cfg(feature = "vector-hnsw")]
    hnsw_cache: SharedHnswCache,
}

impl Collection {
    pub fn new(name: impl Into<String>, backend: Arc<dyn StorageBackend>) -> Self {
        Collection {
            name: name.into(),
            backend,
            index_cache: Mutex::new(None),
            sync_hook: None,
            #[cfg(feature = "vector-hnsw")]
            hnsw_cache: crate::vector::new_shared_cache(),
        }
    }

    /// Attach a sync hook that receives a [`SyncEvent`] after every successful
    /// write commit.  Pass `Arc::new(NoopSyncHook)` to disable (default).
    pub fn with_sync_hook(mut self, hook: Arc<dyn SyncHook>) -> Self {
        self.sync_hook = Some(hook);
        self
    }

    /// Attach a shared HNSW cache (called by `Database::collection()` so all
    /// handles from the same `Database` share a single graph store).
    #[cfg(feature = "vector-hnsw")]
    pub(crate) fn with_hnsw_cache(mut self, cache: SharedHnswCache) -> Self {
        self.hnsw_cache = cache;
        self
    }

    /// Validate that a collection name does not contain the `"::"` separator
    /// used internally for table names (e.g. `"collection::field"`).
    /// A name containing `"::"` would produce table-name collisions between
    /// collections and their indexes.
    fn validate_name(name: &str) -> Result<(), TalaDbError> {
        if name.contains("::") {
            return Err(TalaDbError::InvalidName(format!(
                "collection name \"{name}\" must not contain \"::\" \
                 (reserved for internal table naming)"
            )));
        }
        if name.is_empty() {
            return Err(TalaDbError::InvalidName(
                "collection name must not be empty".into(),
            ));
        }
        Ok(())
    }

    fn invalidate_index_cache(&self) {
        if let Ok(mut guard) = self.index_cache.lock() {
            *guard = None;
        }
    }

    fn load_indexes_cached(&self) -> Result<CachedIndexes, TalaDbError> {
        let mut guard = self.index_cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(ref cached) = *guard {
            return Ok(CachedIndexes {
                indexes: cached.indexes.clone(),
                fts_indexes: cached.fts_indexes.clone(),
                vec_indexes: cached.vec_indexes.clone(),
                compound_indexes: cached.compound_indexes.clone(),
            });
        }
        let indexes = self.load_indexes()?;
        let fts_indexes = self.load_fts_indexes()?;
        let vec_indexes = self.load_vector_indexes()?;
        let compound_indexes = self.load_compound_indexes()?;
        *guard = Some(CachedIndexes {
            indexes: indexes.clone(),
            fts_indexes: fts_indexes.clone(),
            vec_indexes: vec_indexes.clone(),
            compound_indexes: compound_indexes.clone(),
        });
        Ok(CachedIndexes {
            indexes,
            fts_indexes,
            vec_indexes,
            compound_indexes,
        })
    }

    /// Ensure the `_changed_at` secondary index exists for this collection.
    ///
    /// Called automatically before every mutation so `export_changes` can use
    /// an index range scan instead of a full table scan.  `create_index` is
    /// idempotent, so this is a no-op after the first call.
    fn ensure_changed_at_index(&self) -> Result<(), TalaDbError> {
        self.create_index("_changed_at")
    }

    // ------------------------------------------------------------------
    // Index management
    // ------------------------------------------------------------------

    pub fn create_index(&self, field: &str) -> Result<(), TalaDbError> {
        Self::validate_name(&self.name)?;
        let meta_key = meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent: no-op if already exists
        if wtxn.get(META_INDEXES_TABLE, meta_key.as_bytes())?.is_some() {
            return Ok(());
        }

        // Write index metadata
        let def = IndexDef {
            collection: self.name.clone(),
            field: field.to_string(),
        };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_INDEXES_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents into the new index
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(
            &docs_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        let idx_table = index_table_name(&self.name, field);
        for (_, doc_bytes) in existing {
            let doc: Document = postcard::from_bytes(&doc_bytes)?;
            if let Some(val) = doc.get(field) {
                if let Some(idx_key) = encode_index_key(val, doc.id) {
                    wtxn.put(&idx_table, &idx_key, &[])?;
                }
            }
        }

        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    pub fn drop_index(&self, field: &str) -> Result<(), TalaDbError> {
        let meta_key = meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_INDEXES_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(TalaDbError::IndexNotFound(meta_key));
        }

        // Remove all index entries (range scan on the index table)
        let idx_table = index_table_name(&self.name, field);
        let all_entries = wtxn.range(
            &idx_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        for (k, _) in all_entries {
            wtxn.delete(&idx_table, &k)?;
        }

        // Remove metadata
        wtxn.delete(META_INDEXES_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    // ------------------------------------------------------------------
    // FTS index management
    // ------------------------------------------------------------------

    /// Create a full-text search index on a string field.
    /// After calling this, `Filter::Contains(field, query)` will use the index.
    pub fn create_fts_index(&self, field: &str) -> Result<(), TalaDbError> {
        Self::validate_name(&self.name)?;
        let meta_key = format!("{}::{}", self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent: no-op if already exists
        if wtxn.get(META_FTS_TABLE, meta_key.as_bytes())?.is_some() {
            return Ok(());
        }

        let def = FtsDef {
            collection: self.name.clone(),
            field: field.to_string(),
        };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_FTS_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(
            &docs_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        let fts_table = fts_table_name(&self.name, field);
        for (_, doc_bytes) in existing {
            let doc: Document = postcard::from_bytes(&doc_bytes)?;
            if let Some(crate::document::Value::Str(text)) = doc.get(field) {
                for token in tokenize(text) {
                    let fts_key = encode_fts_key(&token, &doc.id);
                    wtxn.put(&fts_table, &fts_key, &[])?;
                }
            }
        }

        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Drop a full-text search index and all its entries.
    pub fn drop_fts_index(&self, field: &str) -> Result<(), TalaDbError> {
        let meta_key = format!("{}::{}", self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_FTS_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(TalaDbError::IndexNotFound(format!("fts:{}", meta_key)));
        }

        // Clear all FTS entries for this field
        let fts_table = fts_table_name(&self.name, field);
        let all = wtxn.range(
            &fts_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        for (k, _) in all {
            wtxn.delete(&fts_table, &k)?;
        }
        wtxn.delete(META_FTS_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    // ------------------------------------------------------------------
    // Compound index management
    // ------------------------------------------------------------------

    /// Create a compound index on an ordered list of fields.
    ///
    /// A compound index accelerates queries where all listed fields are
    /// constrained by equality (`Filter::Eq`), e.g.:
    ///
    /// ```ignore
    /// col.create_compound_index(&["lastName", "firstName"])?;
    /// col.find(Filter::And(vec![
    ///     Filter::Eq("lastName".into(), Value::Str("Smith".into())),
    ///     Filter::Eq("firstName".into(), Value::Str("John".into())),
    /// ]))?;
    /// ```
    ///
    /// Backfills existing documents. The index name is derived from the
    /// field list, so `["a","b"]` and `["b","a"]` are two distinct indexes.
    pub fn create_compound_index(&self, fields: &[&str]) -> Result<(), TalaDbError> {
        Self::validate_name(&self.name)?;
        if fields.len() < 2 {
            return Err(TalaDbError::InvalidOperation(
                "compound index requires at least 2 fields".into(),
            ));
        }
        let meta_key = compound_meta_key(&self.name, fields);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent
        if wtxn
            .get(META_COMPOUND_TABLE, meta_key.as_bytes())?
            .is_some()
        {
            return Ok(());
        }

        let def = CompoundIndexDef {
            collection: self.name.clone(),
            fields: fields.iter().map(|s| s.to_string()).collect(),
        };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_COMPOUND_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(
            &docs_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        let ctable = compound_table_name(&self.name, fields);
        for (_, doc_bytes) in existing {
            let doc: Document = postcard::from_bytes(&doc_bytes)?;
            let vals: Option<Vec<&crate::document::Value>> =
                fields.iter().map(|f| doc.get(f)).collect();
            if let Some(v) = vals {
                if let Some(key) = encode_compound_key(&v, doc.id) {
                    wtxn.put(&ctable, &key, &[])?;
                }
            }
        }

        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Drop a compound index and all its stored entries.
    pub fn drop_compound_index(&self, fields: &[&str]) -> Result<(), TalaDbError> {
        let meta_key = compound_meta_key(&self.name, fields);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn
            .get(META_COMPOUND_TABLE, meta_key.as_bytes())?
            .is_none()
        {
            return Err(TalaDbError::IndexNotFound(format!("compound:{}", meta_key)));
        }

        let ctable = compound_table_name(&self.name, fields);
        let all = wtxn.range(
            &ctable,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        for (k, _) in all {
            wtxn.delete(&ctable, &k)?;
        }
        wtxn.delete(META_COMPOUND_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    fn load_compound_indexes(&self) -> Result<Vec<CompoundIndexDef>, TalaDbError> {
        let rtxn = self.backend.begin_read()?;
        let prefix = format!("{}::", self.name);
        let all = rtxn.scan_all(META_COMPOUND_TABLE).unwrap_or_default();
        let mut defs = Vec::new();
        for (k, v) in all {
            let key_str = String::from_utf8_lossy(&k);
            if key_str.starts_with(&prefix) {
                let def: CompoundIndexDef = postcard::from_bytes(&v)?;
                defs.push(def);
            }
        }
        Ok(defs)
    }

    // ------------------------------------------------------------------
    // Vector index management
    // ------------------------------------------------------------------

    /// Create a vector index on `field`.
    ///
    /// - `dimensions`: expected length of every stored vector.
    /// - `metric`: similarity metric used by `find_nearest` (default: Cosine).
    /// - `hnsw`: when `Some`, builds an HNSW approximate-nearest-neighbor index
    ///   in addition to the flat vector table.  Requires the `vector-hnsw` feature;
    ///   ignored (with a no-op) if the feature is disabled.
    ///
    /// Backfills any existing documents that already have a numeric array in
    /// `field`. Silently skips documents where `field` is absent or not a
    /// numeric array.
    pub fn create_vector_index(
        &self,
        field: &str,
        dimensions: usize,
        metric: Option<VectorMetric>,
        hnsw: Option<HnswOptions>,
    ) -> Result<(), TalaDbError> {
        Self::validate_name(&self.name)?;
        let meta_key = vec_meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent: no-op if already exists
        if wtxn.get(META_VECTOR_TABLE, meta_key.as_bytes())?.is_some() {
            return Ok(());
        }

        let resolved_metric = metric.unwrap_or_default();
        let def = VectorDef {
            collection: self.name.clone(),
            field: field.to_string(),
            dimensions,
            metric: resolved_metric.clone(),
        };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_VECTOR_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents into flat vec table
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(
            &docs_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        let vtable = vec_table_name(&self.name, field);
        let mut backfill: Vec<(ulid::Ulid, Vec<f32>)> = Vec::new();
        for (_, doc_bytes) in existing {
            let doc: Document = postcard::from_bytes(&doc_bytes)?;
            if let Some(val) = doc.get(field) {
                if let Some(vec) = value_to_f32_vec(val) {
                    if vec.len() == dimensions {
                        wtxn.put(&vtable, &doc.id.to_bytes(), &encode_f32_vec(&vec))?;
                        backfill.push((doc.id, vec));
                    }
                }
            }
        }

        // Persist HNSW options and build the in-memory graph when requested
        if let Some(hnsw_opts) = hnsw {
            let hnsw_meta_key = format!("{}::{}", self.name, field);
            let opts_bytes = postcard::to_allocvec(&hnsw_opts)?;
            wtxn.put(META_HNSW_TABLE, hnsw_meta_key.as_bytes(), &opts_bytes)?;

            #[cfg(feature = "vector-hnsw")]
            {
                let graph = build_hnsw(&backfill, &resolved_metric, hnsw_opts.ef_construction)?;
                let cache_key = format!("{}::{}", self.name, field);
                let mut cache = self.hnsw_cache.lock().unwrap_or_else(|p| p.into_inner());
                cache.insert(cache_key, graph);
            }
        }

        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Drop a vector index and remove all stored vectors for that field.
    /// Also removes any HNSW graph and options associated with this index.
    pub fn drop_vector_index(&self, field: &str) -> Result<(), TalaDbError> {
        let meta_key = vec_meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_VECTOR_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(TalaDbError::VectorIndexNotFound(format!(
                "{}::{}",
                self.name, field
            )));
        }

        // Remove flat vector entries
        let vtable = vec_table_name(&self.name, field);
        let all = wtxn.range(
            &vtable,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        for (k, _) in all {
            wtxn.delete(&vtable, &k)?;
        }

        // Remove HNSW metadata (if present) and evict from in-memory cache
        let hnsw_meta_key = format!("{}::{}", self.name, field);
        let _ = wtxn.delete(META_HNSW_TABLE, hnsw_meta_key.as_bytes());
        #[cfg(feature = "vector-hnsw")]
        {
            let cache_key = format!("{}::{}", self.name, field);
            let mut cache = self.hnsw_cache.lock().unwrap_or_else(|p| p.into_inner());
            cache.remove(&cache_key);
        }

        wtxn.delete(META_VECTOR_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Search for the `top_k` most similar documents to `query` using the
    /// named vector index.
    ///
    /// When the index was created with `hnsw: Some(...)` and the `vector-hnsw`
    /// feature is enabled, uses the HNSW approximate-nearest-neighbor graph for
    /// sub-linear search.  Falls back automatically to the flat brute-force
    /// scan when no HNSW graph is stored (e.g. the feature is disabled, or the
    /// graph has not been built yet).
    ///
    /// If `pre_filter` is `Some`, only documents matching that filter are
    /// considered. This lets you combine metadata filtering with vector
    /// similarity in one call.  Pre-filtering forces flat search regardless of
    /// whether an HNSW graph exists, because the graph does not support
    /// arbitrary set-membership constraints.
    ///
    /// Results are ordered by descending similarity score (highest first).
    pub fn find_nearest(
        &self,
        field: &str,
        query: &[f32],
        top_k: usize,
        pre_filter: Option<Filter>,
    ) -> Result<Vec<VectorSearchResult>, TalaDbError> {
        // 1. Load the vector index definition
        let defs = self.load_vector_indexes()?;
        let def = defs
            .iter()
            .find(|d| d.field == field)
            .ok_or_else(|| TalaDbError::VectorIndexNotFound(format!("{}::{}", self.name, field)))?;

        // 2. Validate query dimensions
        if query.len() != def.dimensions {
            return Err(TalaDbError::VectorDimensionMismatch {
                expected: def.dimensions,
                got: query.len(),
            });
        }

        // 3a. HNSW path — only when no pre-filter and a graph is in the cache.
        #[cfg(feature = "vector-hnsw")]
        if pre_filter.is_none() {
            let cache_key = format!("{}::{}", self.name, field);
            let graph_opt = {
                let cache = self.hnsw_cache.lock().unwrap_or_else(|p| p.into_inner());
                cache.get(&cache_key).cloned()
            };
            if let Some(graph) = graph_opt {
                let scored = search_hnsw(&graph, query, &def.metric, top_k);
                return self.load_results(scored);
            }
        }

        // 3b. Flat (brute-force) path
        let vtable = vec_table_name(&self.name, field);
        let rtxn = self.backend.begin_read()?;
        let all_entries = rtxn.scan_all(&vtable)?;
        drop(rtxn);

        let mut vec_map: Vec<(ulid::Ulid, Vec<f32>)> = Vec::with_capacity(all_entries.len());
        for (key_bytes, val_bytes) in &all_entries {
            if key_bytes.len() == 16 {
                let arr: [u8; 16] = match key_bytes.as_slice().try_into() {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                let id = ulid::Ulid::from_bytes(arr);
                if let Some(v) = decode_f32_vec(val_bytes) {
                    vec_map.push((id, v));
                }
            }
        }

        // 4. Apply pre-filter if provided (restrict to matching doc IDs)
        let candidates: Vec<(ulid::Ulid, Vec<f32>)> = if let Some(filter) = pre_filter {
            let filtered_docs = self.find(filter)?;
            let id_set: std::collections::HashSet<ulid::Ulid> =
                filtered_docs.iter().map(|d| d.id).collect();
            vec_map
                .into_iter()
                .filter(|(id, _)| id_set.contains(id))
                .collect()
        } else {
            vec_map
        };

        // 5. Score all candidates
        let metric = &def.metric;
        let mut scored: Vec<(ulid::Ulid, f32)> = candidates
            .iter()
            .map(|(id, v)| (*id, compute_similarity(metric, query, v)))
            .collect();

        // 6. Sort descending, keep top_k
        scored.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);

        self.load_results(scored)
    }

    /// Rebuild the HNSW graph for a vector index from the current flat vector
    /// table.  Use this after bulk inserts or when the graph has become stale.
    ///
    /// Requires the `vector-hnsw` feature.  Returns `Ok(())` (no-op) when the
    /// feature is disabled or when no HNSW options exist for the given field.
    pub fn upgrade_vector_index(&self, field: &str) -> Result<(), TalaDbError> {
        // Load current VectorDef to get metric & dimensions
        let defs = self.load_vector_indexes()?;
        let def = defs
            .iter()
            .find(|d| d.field == field)
            .ok_or_else(|| TalaDbError::VectorIndexNotFound(format!("{}::{}", self.name, field)))?
            .clone();

        // Load HNSW options — if not present, this index is flat-only; nothing to do
        let hnsw_meta_key = format!("{}::{}", self.name, field);
        let rtxn = self.backend.begin_read()?;
        let opts_bytes = rtxn.get(META_HNSW_TABLE, hnsw_meta_key.as_bytes())?;
        drop(rtxn);

        let hnsw_opts: HnswOptions = match opts_bytes {
            Some(b) => postcard::from_bytes(&b)?,
            None => return Ok(()), // flat index — nothing to upgrade
        };

        // Read all vectors from the flat table
        let vtable = vec_table_name(&self.name, field);
        let rtxn = self.backend.begin_read()?;
        let all_entries = rtxn.scan_all(&vtable)?;
        drop(rtxn);

        let mut vectors: Vec<(ulid::Ulid, Vec<f32>)> = Vec::with_capacity(all_entries.len());
        for (key_bytes, val_bytes) in &all_entries {
            if key_bytes.len() == 16 {
                let arr: [u8; 16] = match key_bytes.as_slice().try_into() {
                    Ok(a) => a,
                    Err(_) => continue,
                };
                let id = ulid::Ulid::from_bytes(arr);
                if let Some(v) = decode_f32_vec(val_bytes) {
                    vectors.push((id, v));
                }
            }
        }

        #[cfg(feature = "vector-hnsw")]
        {
            let graph = build_hnsw(&vectors, &def.metric, hnsw_opts.ef_construction)?;
            let cache_key = format!("{}::{}", self.name, field);
            let mut cache = self.hnsw_cache.lock().unwrap_or_else(|p| p.into_inner());
            cache.insert(cache_key, graph);
        }

        // Suppress unused-variable warning when feature is disabled
        let _ = (hnsw_opts, vectors, def);
        Ok(())
    }

    /// Load full documents for a set of `(Ulid, score)` pairs.
    fn load_results(
        &self,
        scored: Vec<(ulid::Ulid, f32)>,
    ) -> Result<Vec<VectorSearchResult>, TalaDbError> {
        let docs_table = docs_table_name(&self.name);
        let rtxn = self.backend.begin_read()?;
        let mut results = Vec::with_capacity(scored.len());
        for (id, score) in scored {
            if let Some(bytes) = rtxn.get(&docs_table, &id.to_bytes())? {
                let document: Document = postcard::from_bytes(&bytes)?;
                results.push(VectorSearchResult { document, score });
            }
        }
        Ok(results)
    }

    /// Return a description of all indexes on this collection.
    pub fn list_indexes(&self) -> Result<CollectionIndexInfo, TalaDbError> {
        let btree = self.load_indexes()?.into_iter().map(|d| d.field).collect();
        let fts = self
            .load_fts_indexes()?
            .into_iter()
            .map(|d| d.field)
            .collect();
        let vector = self
            .load_vector_indexes()?
            .into_iter()
            .map(|d| d.field)
            .collect();
        Ok(CollectionIndexInfo { btree, fts, vector })
    }

    fn load_vector_indexes(&self) -> Result<Vec<VectorDef>, TalaDbError> {
        let rtxn = self.backend.begin_read()?;
        let prefix = format!("{}::", self.name);
        let all = rtxn.scan_all(META_VECTOR_TABLE).unwrap_or_default();
        let mut defs = Vec::new();
        for (k, v) in all {
            let key_str = String::from_utf8_lossy(&k);
            if key_str.starts_with(&prefix) {
                let def: VectorDef = postcard::from_bytes(&v)?;
                defs.push(def);
            }
        }
        Ok(defs)
    }

    fn load_fts_indexes(&self) -> Result<Vec<FtsDef>, TalaDbError> {
        let rtxn = self.backend.begin_read()?;
        let prefix = format!("{}::", self.name);
        let all = rtxn.scan_all(META_FTS_TABLE).unwrap_or_default();
        let mut defs = Vec::new();
        for (k, v) in all {
            let key_str = String::from_utf8_lossy(&k);
            if key_str.starts_with(&prefix) {
                let def: FtsDef = postcard::from_bytes(&v)?;
                defs.push(def);
            }
        }
        Ok(defs)
    }

    fn load_indexes(&self) -> Result<Vec<IndexDef>, TalaDbError> {
        let rtxn = self.backend.begin_read()?;
        let prefix = format!("{}::", self.name);
        // Scan meta table and filter by collection prefix
        let all = rtxn.scan_all(META_INDEXES_TABLE).unwrap_or_default();
        let mut defs = Vec::new();
        for (k, v) in all {
            let key_str = String::from_utf8_lossy(&k);
            if key_str.starts_with(&prefix) {
                let def: IndexDef = postcard::from_bytes(&v)?;
                defs.push(def);
            }
        }
        Ok(defs)
    }

    // ------------------------------------------------------------------
    // Write helpers
    // ------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    fn write_doc_and_indexes_with_compound(
        &self,
        doc: &Document,
        old_doc: Option<&Document>,
        indexes: &[IndexDef],
        fts_indexes: &[FtsDef],
        vec_indexes: &[VectorDef],
        compound_indexes: &[CompoundIndexDef],
        wtxn: &mut dyn crate::engine::WriteTxn,
    ) -> Result<(), TalaDbError> {
        let docs_table = docs_table_name(&self.name);
        let doc_bytes = postcard::to_allocvec(doc)?;
        wtxn.put(&docs_table, &doc.id.to_bytes(), &doc_bytes)?;

        // Secondary indexes
        for idx in indexes {
            let idx_table = index_table_name(&self.name, &idx.field);
            if let Some(old) = old_doc {
                if let Some(old_val) = old.get(&idx.field) {
                    if let Some(old_key) = encode_index_key(old_val, old.id) {
                        wtxn.delete(&idx_table, &old_key)?;
                    }
                }
            }
            if let Some(new_val) = doc.get(&idx.field) {
                if let Some(idx_key) = encode_index_key(new_val, doc.id) {
                    wtxn.put(&idx_table, &idx_key, &[])?;
                }
            }
        }

        // FTS indexes
        for fts in fts_indexes {
            let fts_table = fts_table_name(&self.name, &fts.field);
            // Remove old tokens
            if let Some(old) = old_doc {
                if let Some(crate::document::Value::Str(old_text)) = old.get(&fts.field) {
                    for token in tokenize(old_text) {
                        let key = encode_fts_key(&token, &old.id);
                        wtxn.delete(&fts_table, &key)?;
                    }
                }
            }
            // Write new tokens
            if let Some(crate::document::Value::Str(new_text)) = doc.get(&fts.field) {
                for token in tokenize(new_text) {
                    let key = encode_fts_key(&token, &doc.id);
                    wtxn.put(&fts_table, &key, &[])?;
                }
            }
        }

        // Vector indexes
        for vdef in vec_indexes {
            let vtable = vec_table_name(&self.name, &vdef.field);
            // Remove old vector entry if updating
            if old_doc.is_some() {
                wtxn.delete(&vtable, &doc.id.to_bytes())?;
            }
            // Write new vector if field is present and is a valid numeric array
            if let Some(val) = doc.get(&vdef.field) {
                if let Some(vec) = value_to_f32_vec(val) {
                    if vec.len() == vdef.dimensions {
                        wtxn.put(&vtable, &doc.id.to_bytes(), &encode_f32_vec(&vec))?;
                    }
                }
            }
        }

        // Compound indexes
        for cidx in compound_indexes {
            let field_refs: Vec<&str> = cidx.fields.iter().map(|s| s.as_str()).collect();
            let ctable = compound_table_name(&self.name, &field_refs);
            // Remove old compound entry
            if let Some(old) = old_doc {
                let old_vals: Option<Vec<&Value>> = field_refs.iter().map(|f| old.get(f)).collect();
                if let Some(v) = old_vals {
                    if let Some(old_key) = encode_compound_key(&v, old.id) {
                        wtxn.delete(&ctable, &old_key)?;
                    }
                }
            }
            // Write new compound entry
            let new_vals: Option<Vec<&Value>> = field_refs.iter().map(|f| doc.get(f)).collect();
            if let Some(v) = new_vals {
                if let Some(new_key) = encode_compound_key(&v, doc.id) {
                    wtxn.put(&ctable, &new_key, &[])?;
                }
            }
        }

        Ok(())
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    pub fn insert(&self, mut fields: Vec<(String, Value)>) -> Result<Ulid, TalaDbError> {
        // Auto-stamp _changed_at so LWW merge works correctly without manual calls.
        fields.retain(|(k, _)| k != "_changed_at");
        fields.push(("_changed_at".into(), Value::Int(now_ms() as i64)));
        let doc = Document::new(fields);
        self.ensure_changed_at_index()?;
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let mut wtxn = self.backend.begin_write()?;
        self.write_doc_and_indexes_with_compound(
            &doc,
            None,
            &indexes,
            &fts,
            &vecs,
            &cidxs,
            wtxn.as_mut(),
        )?;
        let id = doc.id;
        wtxn.commit()?;
        if let Some(hook) = &self.sync_hook {
            hook.on_event(SyncEvent::Insert {
                collection: self.name.clone(),
                id: id.to_string(),
                document: doc,
            });
        }
        Ok(id)
    }

    pub fn insert_many(&self, items: Vec<Vec<(String, Value)>>) -> Result<Vec<Ulid>, TalaDbError> {
        let ts = now_ms() as i64;
        let docs: Vec<Document> = items
            .into_iter()
            .map(|mut fields| {
                fields.retain(|(k, _)| k != "_changed_at");
                fields.push(("_changed_at".into(), Value::Int(ts)));
                Document::new(fields)
            })
            .collect();
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let mut wtxn = self.backend.begin_write()?;
        let mut ids = Vec::with_capacity(docs.len());
        for doc in &docs {
            self.write_doc_and_indexes_with_compound(
                doc,
                None,
                &indexes,
                &fts,
                &vecs,
                &cidxs,
                wtxn.as_mut(),
            )?;
            ids.push(doc.id);
        }
        wtxn.commit()?;
        if let Some(hook) = &self.sync_hook {
            for doc in &docs {
                hook.on_event(SyncEvent::Insert {
                    collection: self.name.clone(),
                    id: doc.id.to_string(),
                    document: doc.clone(),
                });
            }
        }
        Ok(ids)
    }

    pub fn find(&self, filter: Filter) -> Result<Vec<Document>, TalaDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let cidxs = self.load_compound_indexes()?;
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        execute(&qplan, &filter, rtxn.as_ref(), &self.name)
    }

    pub fn find_one(&self, filter: Filter) -> Result<Option<Document>, TalaDbError> {
        Ok(self.find(filter)?.into_iter().next())
    }

    /// Like `find`, but with sort, pagination, and field projection.
    ///
    /// Processing order:
    /// 1. Filter (index-accelerated where possible)
    /// 2. Sort (`options.sort`)
    /// 3. Skip (`options.skip`)
    /// 4. Limit (`options.limit`)
    /// 5. Projection (`options.fields`)
    pub fn find_with_options(
        &self,
        filter: Filter,
        options: FindOptions,
    ) -> Result<Vec<Document>, TalaDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let cidxs = self.load_compound_indexes()?;
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        let mut docs = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;

        // Sort
        if !options.sort.is_empty() {
            sort_documents(&mut docs, &options.sort);
        }

        // Skip
        if options.skip > 0 {
            let skip = options.skip as usize;
            if skip >= docs.len() {
                return Ok(vec![]);
            }
            docs = docs.split_off(skip);
        }

        // Limit
        if let Some(limit) = options.limit {
            docs.truncate(limit as usize);
        }

        // Projection
        if let Some(ref fields) = options.fields {
            docs = docs
                .into_iter()
                .map(|d| project_document(d, fields))
                .collect();
        }

        Ok(docs)
    }

    /// Execute an aggregation pipeline against the collection.
    ///
    /// If the first stage is `Stage::Match`, the query planner is consulted so
    /// that any available index can be used to narrow the candidate set before
    /// the remaining stages run.
    pub fn aggregate(
        &self,
        pipeline: crate::aggregate::Pipeline,
    ) -> Result<Vec<Document>, TalaDbError> {
        let (initial_docs, rest_start) = if let Some(Stage::Match(filter)) = pipeline.first() {
            let indexes = self.load_indexes()?;
            let fts = self.load_fts_indexes()?;
            let cidxs = self.load_compound_indexes()?;
            let plan = plan_full(filter, &indexes, &fts, &cidxs);
            let rtxn = self.backend.begin_read()?;
            let docs = execute(&plan, filter, rtxn.as_ref(), &self.name)?;
            (docs, 1usize)
        } else {
            let rtxn = self.backend.begin_read()?;
            let docs = execute(
                &crate::query::planner::QueryPlan::FullScan,
                &Filter::All,
                rtxn.as_ref(),
                &self.name,
            )?;
            (docs, 0usize)
        };

        execute_pipeline(initial_docs, &pipeline[rest_start..])
    }

    pub fn insert_with_id(&self, doc: Document) -> Result<Ulid, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let mut wtxn = self.backend.begin_write()?;
        let id = doc.id;
        self.write_doc_and_indexes_with_compound(
            &doc,
            None,
            &indexes,
            &fts,
            &vecs,
            &cidxs,
            wtxn.as_mut(),
        )?;
        wtxn.commit()?;
        if let Some(hook) = &self.sync_hook {
            hook.on_event(SyncEvent::Insert {
                collection: self.name.clone(),
                id: id.to_string(),
                document: doc,
            });
        }
        Ok(id)
    }

    pub fn find_by_id(&self, id: Ulid) -> Result<Option<Document>, TalaDbError> {
        let docs_table = docs_table_name(&self.name);
        let rtxn = self.backend.begin_read()?;
        match rtxn.get(&docs_table, &id.to_bytes())? {
            Some(bytes) => Ok(Some(postcard::from_bytes(&bytes)?)),
            None => Ok(None),
        }
    }

    pub fn delete_by_id(&self, id: Ulid) -> Result<bool, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let docs_table = docs_table_name(&self.name);
        let rtxn = self.backend.begin_read()?;
        let doc: Option<Document> = match rtxn.get(&docs_table, &id.to_bytes())? {
            Some(bytes) => Some(postcard::from_bytes(&bytes)?),
            None => None,
        };
        drop(rtxn);
        match doc {
            None => Ok(false),
            Some(doc) => {
                let mut wtxn = self.backend.begin_write()?;
                self.delete_doc_and_indexes_with_compound(
                    &doc,
                    &indexes,
                    &fts,
                    &vecs,
                    &cidxs,
                    wtxn.as_mut(),
                )?;
                wtxn.commit()?;
                if let Some(hook) = &self.sync_hook {
                    hook.on_event(SyncEvent::Delete {
                        collection: self.name.clone(),
                        id: id.to_string(),
                    });
                }
                Ok(true)
            }
        }
    }

    pub fn update_one(&self, filter: Filter, update: Update) -> Result<bool, TalaDbError> {
        self.ensure_changed_at_index()?;
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(old_doc) = candidates.drain(..).next() {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, update)?;
            let changes = if self.sync_hook.is_some() {
                diff_documents(&old_doc, &new_doc)
            } else {
                HashMap::new()
            };
            let mut wtxn = self.backend.begin_write()?;
            self.write_doc_and_indexes_with_compound(
                &new_doc,
                Some(&old_doc),
                &indexes,
                &fts,
                &vecs,
                &cidxs,
                wtxn.as_mut(),
            )?;
            wtxn.commit()?;
            if let Some(hook) = &self.sync_hook {
                hook.on_event(SyncEvent::Update {
                    collection: self.name.clone(),
                    id: old_doc.id.to_string(),
                    changes,
                });
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub fn update_many(&self, filter: Filter, update: Update) -> Result<u64, TalaDbError> {
        self.ensure_changed_at_index()?;
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let has_hook = self.sync_hook.is_some();
        let mut events: Vec<SyncEvent> = if has_hook {
            Vec::with_capacity(candidates.len())
        } else {
            Vec::new()
        };
        let mut wtxn = self.backend.begin_write()?;
        for old_doc in &candidates {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, update.clone())?;
            if has_hook {
                events.push(SyncEvent::Update {
                    collection: self.name.clone(),
                    id: old_doc.id.to_string(),
                    changes: diff_documents(old_doc, &new_doc),
                });
            }
            self.write_doc_and_indexes_with_compound(
                &new_doc,
                Some(old_doc),
                &indexes,
                &fts,
                &vecs,
                &cidxs,
                wtxn.as_mut(),
            )?;
            count += 1;
        }
        wtxn.commit()?;
        if let Some(hook) = &self.sync_hook {
            for event in events {
                hook.on_event(event);
            }
        }
        Ok(count)
    }

    pub fn delete_one(&self, filter: Filter) -> Result<bool, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(doc) = candidates.drain(..).next() {
            let doc_id = doc.id.to_string();
            let mut wtxn = self.backend.begin_write()?;
            self.delete_doc_and_indexes_with_compound(
                &doc,
                &indexes,
                &fts,
                &vecs,
                &cidxs,
                wtxn.as_mut(),
            )?;
            wtxn.commit()?;
            if let Some(hook) = &self.sync_hook {
                hook.on_event(SyncEvent::Delete {
                    collection: self.name.clone(),
                    id: doc_id,
                });
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub fn delete_many(&self, filter: Filter) -> Result<u64, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs, cidxs) = (
            cache.indexes,
            cache.fts_indexes,
            cache.vec_indexes,
            cache.compound_indexes,
        );
        let qplan = plan_full(&filter, &indexes, &fts, &cidxs);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let mut wtxn = self.backend.begin_write()?;
        for doc in &candidates {
            self.delete_doc_and_indexes_with_compound(
                doc,
                &indexes,
                &fts,
                &vecs,
                &cidxs,
                wtxn.as_mut(),
            )?;
            count += 1;
        }
        wtxn.commit()?;
        if let Some(hook) = &self.sync_hook {
            for doc in &candidates {
                hook.on_event(SyncEvent::Delete {
                    collection: self.name.clone(),
                    id: doc.id.to_string(),
                });
            }
        }
        Ok(count)
    }

    pub fn count(&self, filter: Filter) -> Result<u64, TalaDbError> {
        Ok(self.find(filter)?.len() as u64)
    }

    /// Remove tombstones older than `before_ms` (milliseconds since Unix epoch).
    ///
    /// Tombstones record deleted document IDs so deletions can propagate via the
    /// sync changeset API.  Once all replicas are known to have received a
    /// deletion (i.e. after your retention window has elapsed), those tombstones
    /// can be safely pruned to reclaim storage.
    ///
    /// Returns the number of tombstones removed.
    ///
    /// # Example
    /// ```ignore
    /// // Prune tombstones older than 30 days
    /// let cutoff = now_ms() - 30 * 24 * 60 * 60 * 1000;
    /// let pruned = collection.compact_tombstones(cutoff)?;
    /// ```
    pub fn compact_tombstones(&self, before_ms: u64) -> Result<u64, TalaDbError> {
        let tomb_table = tomb_table_name(&self.name);
        let rtxn = self.backend.begin_read()?;
        let all = rtxn.scan_all(&tomb_table).unwrap_or_default();

        // Collect IDs whose tombstone timestamp is older than before_ms.
        let to_prune: Vec<Vec<u8>> = all
            .into_iter()
            .filter_map(|(key_bytes, val_bytes)| {
                let ts: i64 = postcard::from_bytes(&val_bytes).ok()?;
                if (ts as u64) < before_ms {
                    Some(key_bytes)
                } else {
                    None
                }
            })
            .collect();

        if to_prune.is_empty() {
            return Ok(0);
        }

        drop(rtxn);
        let count = to_prune.len() as u64;
        let mut wtxn = self.backend.begin_write()?;
        for key in &to_prune {
            wtxn.delete(&tomb_table, key)?;
        }
        wtxn.commit()?;
        Ok(count)
    }

    fn delete_doc_and_indexes_with_compound(
        &self,
        doc: &Document,
        indexes: &[IndexDef],
        fts_indexes: &[FtsDef],
        vec_indexes: &[VectorDef],
        compound_indexes: &[CompoundIndexDef],
        wtxn: &mut dyn crate::engine::WriteTxn,
    ) -> Result<(), TalaDbError> {
        let docs_table = docs_table_name(&self.name);
        wtxn.delete(&docs_table, &doc.id.to_bytes())?;

        // Write a tombstone so this deletion can be exported via SyncAdapter
        // and propagated to remote replicas that may not have received the
        // HTTP push event.
        let tomb_table = tomb_table_name(&self.name);
        let ts_bytes = postcard::to_allocvec(&(now_ms() as i64))?;
        wtxn.put(&tomb_table, &doc.id.to_bytes(), &ts_bytes)?;

        for idx in indexes {
            let idx_table = index_table_name(&self.name, &idx.field);
            if let Some(val) = doc.get(&idx.field) {
                if let Some(idx_key) = encode_index_key(val, doc.id) {
                    wtxn.delete(&idx_table, &idx_key)?;
                }
            }
        }

        for fts in fts_indexes {
            let fts_table = fts_table_name(&self.name, &fts.field);
            if let Some(crate::document::Value::Str(text)) = doc.get(&fts.field) {
                for token in tokenize(text) {
                    let key = encode_fts_key(&token, &doc.id);
                    wtxn.delete(&fts_table, &key)?;
                }
            }
        }

        for vdef in vec_indexes {
            let vtable = vec_table_name(&self.name, &vdef.field);
            wtxn.delete(&vtable, &doc.id.to_bytes())?;
        }

        for cidx in compound_indexes {
            let field_refs: Vec<&str> = cidx.fields.iter().map(|s| s.as_str()).collect();
            let ctable = compound_table_name(&self.name, &field_refs);
            let vals: Option<Vec<&Value>> = field_refs.iter().map(|f| doc.get(f)).collect();
            if let Some(v) = vals {
                if let Some(key) = encode_compound_key(&v, doc.id) {
                    wtxn.delete(&ctable, &key)?;
                }
            }
        }

        Ok(())
    }
}

fn apply_update(doc: &mut Document, update: Update) -> Result<(), TalaDbError> {
    match update {
        Update::Set(pairs) => {
            for (k, v) in pairs {
                doc.set(k, v);
            }
        }
        Update::Unset(keys) => {
            for k in keys {
                doc.remove(&k);
            }
        }
        Update::Inc(pairs) => {
            for (k, delta) in pairs {
                let new_val = match (doc.get(&k), &delta) {
                    (Some(Value::Int(n)), Value::Int(d)) => Value::Int(n + d),
                    (Some(Value::Float(n)), Value::Float(d)) => Value::Float(n + d),
                    (Some(Value::Int(n)), Value::Float(d)) => Value::Float(*n as f64 + d),
                    (None, _) => delta,
                    (Some(existing), _) => {
                        return Err(TalaDbError::TypeError {
                            expected: "numeric".into(),
                            got: existing.type_name().into(),
                        })
                    }
                };
                doc.set(k, new_val);
            }
        }
        Update::Push(key, val) => match doc.get(&key).cloned() {
            Some(Value::Array(mut arr)) => {
                arr.push(val);
                doc.set(key, Value::Array(arr));
            }
            None => {
                doc.set(key, Value::Array(vec![val]));
            }
            Some(existing) => {
                return Err(TalaDbError::TypeError {
                    expected: "array".into(),
                    got: existing.type_name().into(),
                })
            }
        },
        Update::Pull(key, val) => {
            if let Some(Value::Array(arr)) = doc.get(&key).cloned() {
                let filtered: Vec<Value> = arr.into_iter().filter(|v| v != &val).collect();
                doc.set(key, Value::Array(filtered));
            }
        }
    }
    // Auto-advance _changed_at on every mutation so LWW always has a fresh timestamp.
    doc.set("_changed_at", Value::Int(now_ms() as i64));
    Ok(())
}

/// Compute the diff between `old` and `new`, returning only the changed fields.
///
/// - A field present in `new` but not in `old` → included with the new value.
/// - A field present in both but with a different value → included with the new value.
/// - A field present in `old` but absent from `new` → included with `Value::Null`
///   (tombstone, signals deletion).
/// - Unchanged fields are not included.
fn diff_documents(old: &Document, new: &Document) -> HashMap<String, Value> {
    let mut changes = HashMap::new();
    for (k, new_val) in &new.fields {
        match old.get(k) {
            None => {
                changes.insert(k.clone(), new_val.clone());
            }
            Some(old_val) if old_val != new_val => {
                changes.insert(k.clone(), new_val.clone());
            }
            _ => {}
        }
    }
    // Fields removed from old doc
    for (k, _) in &old.fields {
        if new.get(k).is_none() {
            changes.insert(k.clone(), Value::Null);
        }
    }
    changes
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::sync::RecordingSyncHook;
    use crate::Database;

    fn db() -> Database {
        Database::open_in_memory().unwrap()
    }

    fn hooked(db: &Database, name: &str) -> (Collection, Arc<RecordingSyncHook>) {
        let hook = Arc::new(RecordingSyncHook::new());
        let col = db
            .collection(name)
            .with_sync_hook(Arc::clone(&hook) as Arc<dyn SyncHook>);
        (col, hook)
    }

    // ── insert ───────────────────────────────────────────────────────────────

    #[test]
    fn insert_fires_insert_event() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        let id = col
            .insert(vec![("name".into(), Value::Str("Alice".into()))])
            .unwrap();
        let events = hook.take();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::Insert {
                collection,
                id: eid,
                document,
            } => {
                assert_eq!(collection, "items");
                assert_eq!(eid, &id.to_string());
                assert_eq!(document.get("name"), Some(&Value::Str("Alice".into())));
            }
            other => panic!("expected Insert, got {other:?}"),
        }
    }

    #[test]
    fn no_hook_insert_no_panic() {
        let db = db();
        let col = db.collection("items");
        assert!(col.insert(vec![("x".into(), Value::Int(1))]).is_ok());
    }

    // ── insert_many ──────────────────────────────────────────────────────────

    #[test]
    fn insert_many_fires_one_event_per_doc() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        let ids = col
            .insert_many(vec![
                vec![("n".into(), Value::Int(1))],
                vec![("n".into(), Value::Int(2))],
                vec![("n".into(), Value::Int(3))],
            ])
            .unwrap();
        let events = hook.take();
        assert_eq!(events.len(), 3);
        for (i, event) in events.iter().enumerate() {
            match event {
                SyncEvent::Insert { id, .. } => assert_eq!(id, &ids[i].to_string()),
                other => panic!("expected Insert, got {other:?}"),
            }
        }
    }

    // ── update_one ───────────────────────────────────────────────────────────

    #[test]
    fn update_one_fires_update_event_with_delta() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.insert(vec![
            ("name".into(), Value::Str("Alice".into())),
            ("score".into(), Value::Int(10)),
        ])
        .unwrap();
        hook.take(); // discard Insert event

        col.update_one(
            Filter::Eq("name".into(), Value::Str("Alice".into())),
            Update::Set(vec![("score".into(), Value::Int(20))]),
        )
        .unwrap();

        let events = hook.take();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::Update {
                collection,
                changes,
                ..
            } => {
                assert_eq!(collection, "items");
                // Only the changed field
                assert_eq!(changes.get("score"), Some(&Value::Int(20)));
                // Unchanged field not present
                assert!(!changes.contains_key("name"));
            }
            other => panic!("expected Update, got {other:?}"),
        }
    }

    #[test]
    fn update_one_no_match_fires_no_event() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.update_one(
            Filter::Eq("missing".into(), Value::Bool(true)),
            Update::Set(vec![("x".into(), Value::Int(1))]),
        )
        .unwrap();
        assert_eq!(hook.len(), 0);
    }

    #[test]
    fn update_diff_includes_removed_field_as_null() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.insert(vec![
            ("a".into(), Value::Int(1)),
            ("b".into(), Value::Int(2)),
        ])
        .unwrap();
        hook.take();

        col.update_one(
            Filter::Eq("a".into(), Value::Int(1)),
            Update::Unset(vec!["b".into()]),
        )
        .unwrap();

        let events = hook.take();
        match &events[0] {
            SyncEvent::Update { changes, .. } => {
                assert_eq!(changes.get("b"), Some(&Value::Null));
                assert!(!changes.contains_key("a"));
            }
            other => panic!("expected Update, got {other:?}"),
        }
    }

    // ── update_many ──────────────────────────────────────────────────────────

    #[test]
    fn update_many_fires_one_event_per_doc() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.insert_many(vec![
            vec![
                ("active".into(), Value::Bool(true)),
                ("v".into(), Value::Int(1)),
            ],
            vec![
                ("active".into(), Value::Bool(true)),
                ("v".into(), Value::Int(2)),
            ],
        ])
        .unwrap();
        hook.take();

        let n = col
            .update_many(
                Filter::Eq("active".into(), Value::Bool(true)),
                Update::Set(vec![("active".into(), Value::Bool(false))]),
            )
            .unwrap();
        assert_eq!(n, 2);

        let events = hook.take();
        assert_eq!(events.len(), 2);
        for event in &events {
            match event {
                SyncEvent::Update { changes, .. } => {
                    assert_eq!(changes.get("active"), Some(&Value::Bool(false)));
                    assert!(!changes.contains_key("v"));
                }
                other => panic!("expected Update, got {other:?}"),
            }
        }
    }

    // ── delete_one ───────────────────────────────────────────────────────────

    #[test]
    fn delete_one_fires_delete_event() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        let id = col.insert(vec![("x".into(), Value::Int(1))]).unwrap();
        hook.take();

        col.delete_one(Filter::Eq("x".into(), Value::Int(1)))
            .unwrap();

        let events = hook.take();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::Delete {
                collection,
                id: eid,
            } => {
                assert_eq!(collection, "items");
                assert_eq!(eid, &id.to_string());
            }
            other => panic!("expected Delete, got {other:?}"),
        }
    }

    #[test]
    fn delete_one_no_match_fires_no_event() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.delete_one(Filter::Eq("x".into(), Value::Int(999)))
            .unwrap();
        assert_eq!(hook.len(), 0);
    }

    // ── delete_many ──────────────────────────────────────────────────────────

    #[test]
    fn delete_many_fires_one_event_per_doc() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        col.insert_many(vec![
            vec![("tag".into(), Value::Str("old".into()))],
            vec![("tag".into(), Value::Str("old".into()))],
            vec![("tag".into(), Value::Str("new".into()))],
        ])
        .unwrap();
        hook.take();

        let n = col
            .delete_many(Filter::Eq("tag".into(), Value::Str("old".into())))
            .unwrap();
        assert_eq!(n, 2);

        let events = hook.take();
        assert_eq!(events.len(), 2);
        for event in &events {
            assert!(matches!(event, SyncEvent::Delete { .. }));
        }
    }

    // ── delete_by_id ─────────────────────────────────────────────────────────

    #[test]
    fn delete_by_id_fires_delete_event() {
        let db = db();
        let (col, hook) = hooked(&db, "items");
        let id = col.insert(vec![("x".into(), Value::Int(1))]).unwrap();
        hook.take();

        col.delete_by_id(id).unwrap();

        let events = hook.take();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::Delete { id: eid, .. } => assert_eq!(eid, &id.to_string()),
            other => panic!("expected Delete, got {other:?}"),
        }
    }

    // ── diff_documents ───────────────────────────────────────────────────────

    #[test]
    fn diff_unchanged_doc_is_empty() {
        let doc = Document::new(vec![("a".into(), Value::Int(1))]);
        let diff = diff_documents(&doc, &doc);
        assert!(diff.is_empty());
    }

    #[test]
    fn diff_new_field_included() {
        let old = Document::new(vec![("a".into(), Value::Int(1))]);
        let new = Document::new(vec![
            ("a".into(), Value::Int(1)),
            ("b".into(), Value::Int(2)),
        ]);
        let diff = diff_documents(&old, &new);
        assert_eq!(diff.len(), 1);
        assert_eq!(diff.get("b"), Some(&Value::Int(2)));
    }

    #[test]
    fn diff_removed_field_is_null_tombstone() {
        let old = Document::new(vec![
            ("a".into(), Value::Int(1)),
            ("b".into(), Value::Int(2)),
        ]);
        let new = Document::new(vec![("a".into(), Value::Int(1))]);
        let diff = diff_documents(&old, &new);
        assert_eq!(diff.get("b"), Some(&Value::Null));
        assert!(!diff.contains_key("a"));
    }
}
