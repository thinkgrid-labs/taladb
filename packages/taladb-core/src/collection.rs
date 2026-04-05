use std::sync::{Arc, Mutex};

use ulid::Ulid;

use crate::document::{Document, Value};
use crate::engine::StorageBackend;
use crate::error::TalaDbError;
use crate::fts::{encode_fts_key, fts_table_name, tokenize, FtsDef};
use crate::index::{
    docs_table_name, encode_index_key, index_table_name, meta_key, IndexDef, META_INDEXES_TABLE,
};
use crate::query::executor::execute;
use crate::query::filter::Filter;
use crate::query::planner::plan_with_fts;
use crate::vector::{
    compute_similarity, decode_f32_vec, encode_f32_vec, value_to_f32_vec, vec_meta_key,
    vec_table_name, VectorDef, VectorMetric, VectorSearchResult, META_VECTOR_TABLE,
};

const META_FTS_TABLE: &str = "meta::fts_indexes";

struct CachedIndexes {
    indexes: Vec<IndexDef>,
    fts_indexes: Vec<FtsDef>,
    vec_indexes: Vec<VectorDef>,
}

/// An update operation on a document.
#[derive(Debug, Clone)]
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
}

impl Collection {
    pub fn new(name: impl Into<String>, backend: Arc<dyn StorageBackend>) -> Self {
        Collection {
            name: name.into(),
            backend,
            index_cache: Mutex::new(None),
        }
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
            });
        }
        let indexes = self.load_indexes()?;
        let fts_indexes = self.load_fts_indexes()?;
        let vec_indexes = self.load_vector_indexes()?;
        *guard = Some(CachedIndexes {
            indexes: indexes.clone(),
            fts_indexes: fts_indexes.clone(),
            vec_indexes: vec_indexes.clone(),
        });
        Ok(CachedIndexes {
            indexes,
            fts_indexes,
            vec_indexes,
        })
    }

    // ------------------------------------------------------------------
    // Index management
    // ------------------------------------------------------------------

    pub fn create_index(&self, field: &str) -> Result<(), TalaDbError> {
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
        let meta_key = format!("{}::{}", self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_FTS_TABLE, meta_key.as_bytes())?.is_some() {
            return Err(TalaDbError::IndexExists(format!("fts:{}", meta_key)));
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
    // Vector index management
    // ------------------------------------------------------------------

    /// Create a vector index on `field`.
    ///
    /// - `dimensions`: expected length of every stored vector.
    /// - `metric`: similarity metric used by `find_nearest` (default: Cosine).
    ///
    /// Backfills any existing documents that already have a numeric array in
    /// `field`. Silently skips documents where `field` is absent or not a
    /// numeric array.
    pub fn create_vector_index(
        &self,
        field: &str,
        dimensions: usize,
        metric: Option<VectorMetric>,
    ) -> Result<(), TalaDbError> {
        let meta_key = vec_meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent: no-op if already exists
        if wtxn.get(META_VECTOR_TABLE, meta_key.as_bytes())?.is_some() {
            return Ok(());
        }

        let def = VectorDef {
            collection: self.name.clone(),
            field: field.to_string(),
            dimensions,
            metric: metric.unwrap_or_default(),
        };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_VECTOR_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(
            &docs_table,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        let vtable = vec_table_name(&self.name, field);
        for (_, doc_bytes) in existing {
            let doc: Document = postcard::from_bytes(&doc_bytes)?;
            if let Some(val) = doc.get(field) {
                if let Some(vec) = value_to_f32_vec(val) {
                    if vec.len() == dimensions {
                        wtxn.put(&vtable, &doc.id.to_bytes(), &encode_f32_vec(&vec))?;
                    }
                }
            }
        }

        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Drop a vector index and remove all stored vectors for that field.
    pub fn drop_vector_index(&self, field: &str) -> Result<(), TalaDbError> {
        let meta_key = vec_meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_VECTOR_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(TalaDbError::VectorIndexNotFound(format!(
                "{}::{}",
                self.name, field
            )));
        }

        let vtable = vec_table_name(&self.name, field);
        let all = wtxn.range(
            &vtable,
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
        )?;
        for (k, _) in all {
            wtxn.delete(&vtable, &k)?;
        }
        wtxn.delete(META_VECTOR_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        self.invalidate_index_cache();
        Ok(())
    }

    /// Search for the `top_k` most similar documents to `query` using the
    /// named vector index.
    ///
    /// If `pre_filter` is `Some`, only documents matching that filter are
    /// considered. This lets you combine metadata filtering with vector
    /// similarity in one call.
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

        // 3. Load all stored vectors
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

        // 7. Load full documents for top_k results
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

    fn write_doc_and_indexes(
        &self,
        doc: &Document,
        old_doc: Option<&Document>,
        indexes: &[IndexDef],
        fts_indexes: &[FtsDef],
        vec_indexes: &[VectorDef],
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

        Ok(())
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    pub fn insert(&self, fields: Vec<(String, Value)>) -> Result<Ulid, TalaDbError> {
        let doc = Document::new(fields);
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let mut wtxn = self.backend.begin_write()?;
        self.write_doc_and_indexes(&doc, None, &indexes, &fts, &vecs, wtxn.as_mut())?;
        let id = doc.id;
        wtxn.commit()?;
        Ok(id)
    }

    pub fn insert_many(&self, items: Vec<Vec<(String, Value)>>) -> Result<Vec<Ulid>, TalaDbError> {
        let docs: Vec<Document> = items.into_iter().map(Document::new).collect();
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let mut wtxn = self.backend.begin_write()?;
        let mut ids = Vec::with_capacity(docs.len());
        for doc in &docs {
            self.write_doc_and_indexes(doc, None, &indexes, &fts, &vecs, wtxn.as_mut())?;
            ids.push(doc.id);
        }
        wtxn.commit()?;
        Ok(ids)
    }

    pub fn find(&self, filter: Filter) -> Result<Vec<Document>, TalaDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        execute(&qplan, &filter, rtxn.as_ref(), &self.name)
    }

    pub fn find_one(&self, filter: Filter) -> Result<Option<Document>, TalaDbError> {
        Ok(self.find(filter)?.into_iter().next())
    }

    pub fn insert_with_id(&self, doc: Document) -> Result<Ulid, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let mut wtxn = self.backend.begin_write()?;
        let id = doc.id;
        self.write_doc_and_indexes(&doc, None, &indexes, &fts, &vecs, wtxn.as_mut())?;
        wtxn.commit()?;
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
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
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
                self.delete_doc_and_indexes(&doc, &indexes, &fts, &vecs, wtxn.as_mut())?;
                wtxn.commit()?;
                Ok(true)
            }
        }
    }

    pub fn update_one(&self, filter: Filter, update: Update) -> Result<bool, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(old_doc) = candidates.drain(..).next() {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, update)?;
            let mut wtxn = self.backend.begin_write()?;
            self.write_doc_and_indexes(
                &new_doc,
                Some(&old_doc),
                &indexes,
                &fts,
                &vecs,
                wtxn.as_mut(),
            )?;
            wtxn.commit()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn update_many(&self, filter: Filter, update: Update) -> Result<u64, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let mut wtxn = self.backend.begin_write()?;
        for old_doc in &candidates {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, update.clone())?;
            self.write_doc_and_indexes(
                &new_doc,
                Some(old_doc),
                &indexes,
                &fts,
                &vecs,
                wtxn.as_mut(),
            )?;
            count += 1;
        }
        wtxn.commit()?;
        Ok(count)
    }

    pub fn delete_one(&self, filter: Filter) -> Result<bool, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(doc) = candidates.drain(..).next() {
            let mut wtxn = self.backend.begin_write()?;
            self.delete_doc_and_indexes(&doc, &indexes, &fts, &vecs, wtxn.as_mut())?;
            wtxn.commit()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn delete_many(&self, filter: Filter) -> Result<u64, TalaDbError> {
        let cache = self.load_indexes_cached()?;
        let (indexes, fts, vecs) = (cache.indexes, cache.fts_indexes, cache.vec_indexes);
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let mut wtxn = self.backend.begin_write()?;
        for doc in &candidates {
            self.delete_doc_and_indexes(doc, &indexes, &fts, &vecs, wtxn.as_mut())?;
            count += 1;
        }
        wtxn.commit()?;
        Ok(count)
    }

    pub fn count(&self, filter: Filter) -> Result<u64, TalaDbError> {
        Ok(self.find(filter)?.len() as u64)
    }

    fn delete_doc_and_indexes(
        &self,
        doc: &Document,
        indexes: &[IndexDef],
        fts_indexes: &[FtsDef],
        vec_indexes: &[VectorDef],
        wtxn: &mut dyn crate::engine::WriteTxn,
    ) -> Result<(), TalaDbError> {
        let docs_table = docs_table_name(&self.name);
        wtxn.delete(&docs_table, &doc.id.to_bytes())?;

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
    Ok(())
}
