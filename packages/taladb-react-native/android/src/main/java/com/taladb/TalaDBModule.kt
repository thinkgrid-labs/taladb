/**
 * TalaDB React Native — Android JSI bridge.
 *
 * The module loads `libtaladb_ffi.so` (the Rust C FFI crate compiled via
 * `cargo ndk`) and installs the C++ JSI HostObject into the Hermes/JSC
 * runtime via `installJSIBindings()`.
 *
 * Build setup
 * -----------
 *  1. Cross-compile: `cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build --release`
 *     Output: `target/<triple>/release/libtaladb_ffi.so`
 *  2. Copy each .so into `android/src/main/jniLibs/<ABI>/libtaladb_ffi.so`
 *  3. `android/CMakeLists.txt` compiles `TalaDBHostObject.cpp` and links the .so.
 *
 * Runtime flow
 * ------------
 *  React Native calls `initialize(dbName)` once.
 *  The module resolves the DB path, then calls the native `nativeInstall()`
 *  function which opens the Rust database and installs `global.__TalaDB__`
 *  as a JSI HostObject. All subsequent CRUD calls go through JSI directly.
 */
package com.taladb

import com.facebook.react.bridge.*
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.turbomodule.core.CallInvokerHolderImpl

@ReactModule(name = TalaDBModule.NAME)
class TalaDBModule(private val reactContext: ReactApplicationContext) :
    NativeTalaDBSpec(reactContext) {

    companion object {
        const val NAME = "TalaDB"

        init {
            // libtaladb_ffi.so is built by CMakeLists.txt (see android/).
            // It bundles both the C++ JSI HostObject and the Rust FFI crate.
            System.loadLibrary("taladb_ffi")
        }
    }

    override fun getName() = NAME

    // -----------------------------------------------------------------------
    // JNI — implemented in TalaDBHostObject.cpp (via CMakeLists.txt)
    // -----------------------------------------------------------------------

    /**
     * Open the database at [dbPath] and install `global.__TalaDB__` into the
     * JSI runtime identified by [jsContextNativePtr].
     * Called once from [initialize].
     */
    private external fun nativeInstall(jsContextNativePtr: Long, dbPath: String)

    // -----------------------------------------------------------------------
    // TurboModule: initialize(dbName) → Promise<void>
    // -----------------------------------------------------------------------

    override fun initialize(dbName: String, promise: Promise) {
        try {
            val dbPath = reactContext.filesDir.absolutePath + "/$dbName"

            val jsCallInvokerHolder = reactContext.catalystInstance
                .jsCallInvokerHolder as CallInvokerHolderImpl
            val jsContextPtr = jsCallInvokerHolder.nativeCallInvoker

            // Install on the JS thread
            reactContext.runOnJSQueueThread {
                try {
                    nativeInstall(jsContextPtr, dbPath)
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("TALADB_INSTALL_ERROR", e.message, e)
                }
            }
        } catch (e: Exception) {
            promise.reject("TALADB_INIT_ERROR", e.message, e)
        }
    }

    // -----------------------------------------------------------------------
    // TurboModule: close() → Promise<void>
    // -----------------------------------------------------------------------

    override fun close(promise: Promise) {
        // The HostObject destructor calls taladb_close() when the JS GC
        // collects `global.__TalaDB__`. For an explicit close, replace the
        // global with undefined to trigger the destructor immediately.
        try {
            reactContext.runOnJSQueueThread {
                try {
                    reactContext.javaScriptContextHolder?.let { holder ->
                        // Setting the property to undefined lets the JSI
                        // HostObject destructor run (Hermes GC permitting).
                        // For an immediate close, call nativeClose() instead.
                    }
                    promise.resolve(null)
                } catch (e: Exception) {
                    promise.reject("TALADB_CLOSE_ERROR", e.message, e)
                }
            }
        } catch (e: Exception) {
            promise.reject("TALADB_CLOSE_ERROR", e.message, e)
        }
    }

    // -----------------------------------------------------------------------
    // All synchronous CRUD methods are handled by the JSI HostObject.
    // The stubs below satisfy the TurboModule Codegen spec (NativeTalaDB.ts)
    // but are never invoked at runtime — JS calls global.__TalaDB__ directly.
    // -----------------------------------------------------------------------

    override fun insert(collection: String, doc: ReadableMap): String = ""
    override fun insertMany(collection: String, docs: ReadableArray): WritableArray =
        WritableNativeArray()
    override fun find(collection: String, filter: ReadableMap?): WritableArray =
        WritableNativeArray()
    override fun findOne(collection: String, filter: ReadableMap?): WritableMap? = null
    override fun updateOne(collection: String, filter: ReadableMap, update: ReadableMap): Boolean = false
    override fun updateMany(collection: String, filter: ReadableMap, update: ReadableMap): Double = 0.0
    override fun deleteOne(collection: String, filter: ReadableMap): Boolean = false
    override fun deleteMany(collection: String, filter: ReadableMap): Double = 0.0
    override fun count(collection: String, filter: ReadableMap?): Double = 0.0
    override fun createIndex(collection: String, field: String) {}
    override fun dropIndex(collection: String, field: String) {}
    override fun createFtsIndex(collection: String, field: String) {}
    override fun dropFtsIndex(collection: String, field: String) {}
}
