/**
 * TalaDB React Native — Android JNI bridge
 *
 * Bridges the JavaScript TurboModule API to the Rust `taladb-core` shared
 * library (`libtaladb_core.so`) via JNI.
 *
 * Build requirements:
 *   - Cross-compile taladb-core: `cargo ndk -t arm64-v8a build --release`
 *   - Place `libtaladb_core.so` in `android/src/main/jniLibs/arm64-v8a/`
 *   - Generate JNI header with cbindgen or uniffi
 *
 * Implementation status:
 *   [x] Module registration and JNI stub
 *   [ ] Full JNI implementation (requires uniffi bindings generation)
 */
package com.taladb

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule

@ReactModule(name = TalaDBModule.NAME)
class TalaDBModule(reactContext: ReactApplicationContext) :
    NativeTalaDBSpec(reactContext) {

    companion object {
        const val NAME = "TalaDB"

        init {
            // Load the Rust shared library
            System.loadLibrary("taladb_core")
        }
    }

    override fun getName() = NAME

    // ------------------------------------------------------------------
    // JNI declarations — implemented in Rust via uniffi / cbindgen
    // ------------------------------------------------------------------

    private external fun nativeOpen(dbName: String, path: String): Long
    private external fun nativeClose(handle: Long)
    private external fun nativeInsert(handle: Long, collection: String, docJson: String): String
    private external fun nativeFind(handle: Long, collection: String, filterJson: String): String
    private external fun nativeUpdateOne(handle: Long, collection: String, filterJson: String, updateJson: String): Boolean
    private external fun nativeDeleteOne(handle: Long, collection: String, filterJson: String): Boolean
    private external fun nativeCount(handle: Long, collection: String, filterJson: String): Int

    // DB handle — set by initialize()
    private var handle: Long = 0L

    // ------------------------------------------------------------------
    // TurboModule method implementations
    // ------------------------------------------------------------------

    override fun initialize(dbName: String, promise: Promise) {
        try {
            val dbPath = reactApplicationContext.filesDir.absolutePath + "/$dbName"
            handle = nativeOpen(dbName, dbPath)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("TALADB_OPEN_ERROR", e.message, e)
        }
    }

    override fun close(promise: Promise) {
        try {
            if (handle != 0L) {
                nativeClose(handle)
                handle = 0L
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("TALADB_CLOSE_ERROR", e.message, e)
        }
    }

    override fun insert(collection: String, doc: ReadableMap): String {
        val json = doc.toJsonString()
        return nativeInsert(handle, collection, json)
    }

    override fun insertMany(collection: String, docs: ReadableArray): WritableArray {
        val ids = WritableNativeArray()
        for (i in 0 until docs.size()) {
            val doc = docs.getMap(i) ?: continue
            val id = nativeInsert(handle, collection, doc.toJsonString())
            ids.pushString(id)
        }
        return ids
    }

    override fun find(collection: String, filter: ReadableMap?): WritableArray {
        val filterJson = filter?.toJsonString() ?: "{}"
        val resultJson = nativeFind(handle, collection, filterJson)
        return resultJson.toWritableArray()
    }

    override fun findOne(collection: String, filter: ReadableMap?): WritableMap? {
        val filterJson = filter?.toJsonString() ?: "{}"
        val resultJson = nativeFind(handle, collection, filterJson)
        val arr = resultJson.toWritableArray()
        return if (arr.size() > 0) arr.getMap(0) else null
    }

    override fun updateOne(collection: String, filter: ReadableMap, update: ReadableMap): Boolean {
        return nativeUpdateOne(handle, collection, filter.toJsonString(), update.toJsonString())
    }

    override fun updateMany(collection: String, filter: ReadableMap, update: ReadableMap): Double {
        // TODO: implement nativeUpdateMany
        return 0.0
    }

    override fun deleteOne(collection: String, filter: ReadableMap): Boolean {
        return nativeDeleteOne(handle, collection, filter.toJsonString())
    }

    override fun deleteMany(collection: String, filter: ReadableMap): Double {
        // TODO: implement nativeDeleteMany
        return 0.0
    }

    override fun count(collection: String, filter: ReadableMap?): Double {
        val filterJson = filter?.toJsonString() ?: "{}"
        return nativeCount(handle, collection, filterJson).toDouble()
    }

    override fun createIndex(collection: String, field: String) { /* TODO */ }
    override fun dropIndex(collection: String, field: String) { /* TODO */ }
    override fun createFtsIndex(collection: String, field: String) { /* TODO */ }
    override fun dropFtsIndex(collection: String, field: String) { /* TODO */ }
}

// ---------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------

private fun ReadableMap.toJsonString(): String {
    // Simple JSON serialisation via Android's JSONObject
    val map = toHashMap()
    return org.json.JSONObject(map).toString()
}

private fun String.toWritableArray(): WritableArray {
    val arr = WritableNativeArray()
    val jsonArray = org.json.JSONArray(this)
    for (i in 0 until jsonArray.length()) {
        arr.pushMap(jsonArray.getJSONObject(i).toWritableMap())
    }
    return arr
}

private fun org.json.JSONObject.toWritableMap(): WritableMap {
    val map = WritableNativeMap()
    keys().forEach { key ->
        when (val value = get(key)) {
            is String -> map.putString(key, value)
            is Int -> map.putInt(key, value)
            is Double -> map.putDouble(key, value)
            is Boolean -> map.putBoolean(key, value)
            else -> map.putString(key, value.toString())
        }
    }
    return map
}
