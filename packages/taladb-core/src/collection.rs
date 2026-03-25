use std::sync::Arc;

use ulid::Ulid;

use crate::document::{Document, Value};
use crate::engine::StorageBackend;
use crate::error::ZeroDbError;
use crate::fts::{encode_fts_key, fts_table_name, tokenize, FtsDef};
use crate::index::{
    docs_table_name, encode_index_key, index_table_name, meta_key, IndexDef, META_INDEXES_TABLE,
};
use crate::query::executor::execute;
use crate::query::filter::Filter;
use crate::query::planner::plan_with_fts;

const META_FTS_TABLE: &str = "meta::fts_indexes";

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
}

impl Collection {
    pub fn new(name: impl Into<String>, backend: Arc<dyn StorageBackend>) -> Self {
        Collection { name: name.into(), backend }
    }

    // ------------------------------------------------------------------
    // Index management
    // ------------------------------------------------------------------

    pub fn create_index(&self, field: &str) -> Result<(), ZeroDbError> {
        let meta_key = meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        // Idempotent: no-op if already exists
        if wtxn.get(META_INDEXES_TABLE, meta_key.as_bytes())?.is_some() {
            return Ok(());
        }

        // Write index metadata
        let def = IndexDef { collection: self.name.clone(), field: field.to_string() };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_INDEXES_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents into the new index
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(&docs_table, std::ops::Bound::Unbounded, std::ops::Bound::Unbounded)?;
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
        Ok(())
    }

    pub fn drop_index(&self, field: &str) -> Result<(), ZeroDbError> {
        let meta_key = meta_key(&self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_INDEXES_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(ZeroDbError::IndexNotFound(meta_key));
        }

        // Remove all index entries (range scan on the index table)
        let idx_table = index_table_name(&self.name, field);
        let all_entries = wtxn.range(&idx_table, std::ops::Bound::Unbounded, std::ops::Bound::Unbounded)?;
        for (k, _) in all_entries {
            wtxn.delete(&idx_table, &k)?;
        }

        // Remove metadata
        wtxn.delete(META_INDEXES_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        Ok(())
    }

    // ------------------------------------------------------------------
    // FTS index management
    // ------------------------------------------------------------------

    /// Create a full-text search index on a string field.
    /// After calling this, `Filter::Contains(field, query)` will use the index.
    pub fn create_fts_index(&self, field: &str) -> Result<(), ZeroDbError> {
        let meta_key = format!("{}::{}", self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_FTS_TABLE, meta_key.as_bytes())?.is_some() {
            return Err(ZeroDbError::IndexExists(format!("fts:{}", meta_key)));
        }

        let def = FtsDef { collection: self.name.clone(), field: field.to_string() };
        let bytes = postcard::to_allocvec(&def)?;
        wtxn.put(META_FTS_TABLE, meta_key.as_bytes(), &bytes)?;

        // Backfill existing documents
        let docs_table = docs_table_name(&self.name);
        let existing = wtxn.range(&docs_table, std::ops::Bound::Unbounded, std::ops::Bound::Unbounded)?;
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
        Ok(())
    }

    /// Drop a full-text search index and all its entries.
    pub fn drop_fts_index(&self, field: &str) -> Result<(), ZeroDbError> {
        let meta_key = format!("{}::{}", self.name, field);
        let mut wtxn = self.backend.begin_write()?;

        if wtxn.get(META_FTS_TABLE, meta_key.as_bytes())?.is_none() {
            return Err(ZeroDbError::IndexNotFound(format!("fts:{}", meta_key)));
        }

        // Clear all FTS entries for this field
        let fts_table = fts_table_name(&self.name, field);
        let all = wtxn.range(&fts_table, std::ops::Bound::Unbounded, std::ops::Bound::Unbounded)?;
        for (k, _) in all {
            wtxn.delete(&fts_table, &k)?;
        }
        wtxn.delete(META_FTS_TABLE, meta_key.as_bytes())?;
        wtxn.commit()?;
        Ok(())
    }

    fn load_fts_indexes(&self) -> Result<Vec<FtsDef>, ZeroDbError> {
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

    fn load_indexes(&self) -> Result<Vec<IndexDef>, ZeroDbError> {
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
        wtxn: &mut dyn crate::engine::WriteTxn,
    ) -> Result<(), ZeroDbError> {
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

        Ok(())
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    pub fn insert(&self, fields: Vec<(String, Value)>) -> Result<Ulid, ZeroDbError> {
        let doc = Document::new(fields);
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let mut wtxn = self.backend.begin_write()?;
        self.write_doc_and_indexes(&doc, None, &indexes, &fts, wtxn.as_mut())?;
        let id = doc.id;
        wtxn.commit()?;
        Ok(id)
    }

    pub fn insert_many(&self, items: Vec<Vec<(String, Value)>>) -> Result<Vec<Ulid>, ZeroDbError> {
        let docs: Vec<Document> = items.into_iter().map(Document::new).collect();
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let mut wtxn = self.backend.begin_write()?;
        let mut ids = Vec::with_capacity(docs.len());
        for doc in &docs {
            self.write_doc_and_indexes(doc, None, &indexes, &fts, wtxn.as_mut())?;
            ids.push(doc.id);
        }
        wtxn.commit()?;
        Ok(ids)
    }

    pub fn find(&self, filter: Filter) -> Result<Vec<Document>, ZeroDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        execute(&qplan, &filter, rtxn.as_ref(), &self.name)
    }

    pub fn find_one(&self, filter: Filter) -> Result<Option<Document>, ZeroDbError> {
        Ok(self.find(filter)?.into_iter().next())
    }

    pub fn update_one(&self, filter: Filter, update: Update) -> Result<bool, ZeroDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(old_doc) = candidates.drain(..).next() {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, &update)?;
            let mut wtxn = self.backend.begin_write()?;
            self.write_doc_and_indexes(&new_doc, Some(&old_doc), &indexes, &fts, wtxn.as_mut())?;
            wtxn.commit()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn update_many(&self, filter: Filter, update: Update) -> Result<u64, ZeroDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let mut wtxn = self.backend.begin_write()?;
        for old_doc in &candidates {
            let mut new_doc = old_doc.clone();
            apply_update(&mut new_doc, &update)?;
            self.write_doc_and_indexes(&new_doc, Some(old_doc), &indexes, &fts, wtxn.as_mut())?;
            count += 1;
        }
        wtxn.commit()?;
        Ok(count)
    }

    pub fn delete_one(&self, filter: Filter) -> Result<bool, ZeroDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let mut candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        if let Some(doc) = candidates.drain(..).next() {
            let mut wtxn = self.backend.begin_write()?;
            self.delete_doc_and_indexes(&doc, &indexes, &fts, wtxn.as_mut())?;
            wtxn.commit()?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn delete_many(&self, filter: Filter) -> Result<u64, ZeroDbError> {
        let indexes = self.load_indexes()?;
        let fts = self.load_fts_indexes()?;
        let qplan = plan_with_fts(&filter, &indexes, &fts);
        let rtxn = self.backend.begin_read()?;
        let candidates = execute(&qplan, &filter, rtxn.as_ref(), &self.name)?;
        drop(rtxn);

        let mut count = 0u64;
        let mut wtxn = self.backend.begin_write()?;
        for doc in &candidates {
            self.delete_doc_and_indexes(doc, &indexes, &fts, wtxn.as_mut())?;
            count += 1;
        }
        wtxn.commit()?;
        Ok(count)
    }

    pub fn count(&self, filter: Filter) -> Result<u64, ZeroDbError> {
        Ok(self.find(filter)?.len() as u64)
    }

    fn delete_doc_and_indexes(
        &self,
        doc: &Document,
        indexes: &[IndexDef],
        fts_indexes: &[FtsDef],
        wtxn: &mut dyn crate::engine::WriteTxn,
    ) -> Result<(), ZeroDbError> {
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
        Ok(())
    }
}

fn apply_update(doc: &mut Document, update: &Update) -> Result<(), ZeroDbError> {
    match update {
        Update::Set(pairs) => {
            for (k, v) in pairs {
                doc.set(k.clone(), v.clone());
            }
        }
        Update::Unset(keys) => {
            for k in keys {
                doc.remove(k);
            }
        }
        Update::Inc(pairs) => {
            for (k, delta) in pairs {
                let new_val = match (doc.get(k), delta) {
                    (Some(Value::Int(n)), Value::Int(d)) => Value::Int(n + d),
                    (Some(Value::Float(n)), Value::Float(d)) => Value::Float(n + d),
                    (Some(Value::Int(n)), Value::Float(d)) => Value::Float(*n as f64 + d),
                    (None, _) => delta.clone(),
                    (Some(existing), _) => return Err(ZeroDbError::TypeError {
                        expected: "numeric".into(),
                        got: existing.type_name().into(),
                    }),
                };
                doc.set(k.clone(), new_val);
            }
        }
        Update::Push(key, val) => {
            match doc.get(key).cloned() {
                Some(Value::Array(mut arr)) => {
                    arr.push(val.clone());
                    doc.set(key.clone(), Value::Array(arr));
                }
                None => {
                    doc.set(key.clone(), Value::Array(vec![val.clone()]));
                }
                Some(existing) => return Err(ZeroDbError::TypeError {
                    expected: "array".into(),
                    got: existing.type_name().into(),
                }),
            }
        }
        Update::Pull(key, val) => {
            if let Some(Value::Array(arr)) = doc.get(key).cloned() {
                let filtered: Vec<Value> = arr.into_iter().filter(|v| v != val).collect();
                doc.set(key.clone(), Value::Array(filtered));
            }
        }
    }
    Ok(())
}
