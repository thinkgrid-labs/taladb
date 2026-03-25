#pragma once
#ifndef TALADB_FFI_H
#define TALADB_FFI_H

/*
 * TalaDB C FFI header.
 *
 * This file is the stable C interface between the Rust taladb-ffi crate and
 * the C++ JSI HostObject.  It is kept in sync with rust/src/lib.rs manually
 * (or regenerated with cbindgen — see rust/cbindgen.toml).
 *
 * Ownership rules
 * ---------------
 *  - Strings IN  : caller-owned, UTF-8, null-terminated.
 *  - Strings OUT : heap-allocated by Rust; caller must free with
 *                  taladb_free_string().
 *  - Handles     : allocated by taladb_open(); freed by taladb_close().
 *  - Errors      : string functions return NULL; integer functions return -1.
 */

#include <stdint.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/* -------------------------------------------------------------------------
 * Opaque database handle
 * ---------------------------------------------------------------------- */
typedef struct TalaDbHandle TalaDbHandle;

/* -------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------- */

/** Open (or create) a database at the given file-system path. */
TalaDbHandle *taladb_open(const char *path);

/** Flush and close the database, freeing the handle. */
void taladb_close(TalaDbHandle *handle);

/** Free a C string returned by any taladb_* function. */
void taladb_free_string(char *s);

/* -------------------------------------------------------------------------
 * Insert
 * ---------------------------------------------------------------------- */

/**
 * Insert a document (JSON object).
 * Returns the new document's ULID as a C string, or NULL on error.
 * Caller must free with taladb_free_string().
 */
char *taladb_insert(TalaDbHandle *handle,
                    const char   *collection,
                    const char   *doc_json);

/**
 * Insert multiple documents (JSON array of objects).
 * Returns a JSON array of ULID strings, or NULL on error.
 * Caller must free with taladb_free_string().
 */
char *taladb_insert_many(TalaDbHandle *handle,
                         const char   *collection,
                         const char   *docs_json);

/* -------------------------------------------------------------------------
 * Find
 * ---------------------------------------------------------------------- */

/**
 * Find all documents matching filter_json.
 * Pass "{}" or "null" to match all.
 * Returns a JSON array string, or NULL on error.
 * Caller must free with taladb_free_string().
 */
char *taladb_find(TalaDbHandle *handle,
                  const char   *collection,
                  const char   *filter_json);

/**
 * Find the first document matching filter_json.
 * Returns a JSON object string, or the string "null" if not found.
 * Caller must free with taladb_free_string().
 */
char *taladb_find_one(TalaDbHandle *handle,
                      const char   *collection,
                      const char   *filter_json);

/* -------------------------------------------------------------------------
 * Update
 * ---------------------------------------------------------------------- */

/** Update the first matching document. Returns 1 updated, 0 not found, -1 error. */
int32_t taladb_update_one(TalaDbHandle *handle,
                          const char   *collection,
                          const char   *filter_json,
                          const char   *update_json);

/** Update all matching documents. Returns count updated, or -1 on error. */
int32_t taladb_update_many(TalaDbHandle *handle,
                           const char   *collection,
                           const char   *filter_json,
                           const char   *update_json);

/* -------------------------------------------------------------------------
 * Delete
 * ---------------------------------------------------------------------- */

/** Delete the first matching document. Returns 1 deleted, 0 not found, -1 error. */
int32_t taladb_delete_one(TalaDbHandle *handle,
                          const char   *collection,
                          const char   *filter_json);

/** Delete all matching documents. Returns count deleted, or -1 on error. */
int32_t taladb_delete_many(TalaDbHandle *handle,
                           const char   *collection,
                           const char   *filter_json);

/* -------------------------------------------------------------------------
 * Count
 * ---------------------------------------------------------------------- */

/** Count documents matching filter_json. Returns count, or -1 on error. */
int32_t taladb_count(TalaDbHandle *handle,
                     const char   *collection,
                     const char   *filter_json);

/* -------------------------------------------------------------------------
 * Index management
 * ---------------------------------------------------------------------- */

void taladb_create_index    (TalaDbHandle *handle, const char *collection, const char *field);
void taladb_drop_index      (TalaDbHandle *handle, const char *collection, const char *field);
void taladb_create_fts_index(TalaDbHandle *handle, const char *collection, const char *field);
void taladb_drop_fts_index  (TalaDbHandle *handle, const char *collection, const char *field);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TALADB_FFI_H */
