/**
 * TalaDB JNI glue — Android only.
 *
 * Exposes `nativeInstall(jsContextNativePtr, dbPath, configJson)` to Kotlin so
 * that `TalaDBModule.kt` can install the JSI HostObject from the JS thread.
 *
 * The function signature must match the Kotlin `external fun` declaration:
 *   package  : com.taladb
 *   class    : TalaDBModule
 *   method   : nativeInstall(Long, String, String?)
 *
 * CMakeLists.txt compiles this file together with TalaDBHostObject.cpp.
 */

#include <jni.h>
#include <jsi/jsi.h>
#include <string>

#include "TalaDBHostObject.h"
#include "taladb.h"

using namespace facebook::jsi;

extern "C" JNIEXPORT void JNICALL
Java_com_taladb_TalaDBModule_nativeInstall(
        JNIEnv  *env,
        jobject  /* thiz */,
        jlong    jsContextNativePtr,
        jstring  dbPathJ,
        jstring  configJsonJ)
{
    // Resolve db path
    const char *dbPathC = env->GetStringUTFChars(dbPathJ, nullptr);
    std::string dbPath(dbPathC);
    env->ReleaseStringUTFChars(dbPathJ, dbPathC);

    // Open the Rust database — use taladb_open_with_config when config provided
    TalaDbHandle *db = nullptr;
    if (configJsonJ != nullptr) {
        const char *configC = env->GetStringUTFChars(configJsonJ, nullptr);
        db = taladb_open_with_config(dbPath.c_str(), configC);
        env->ReleaseStringUTFChars(configJsonJ, configC);
    } else {
        db = taladb_open(dbPath.c_str());
    }
    if (!db) return; // failed to open — JS will see no __TalaDB__ global

    // Get the JSI runtime from the pointer passed by RN internals
    auto &rt = *reinterpret_cast<Runtime *>(jsContextNativePtr);

    // Install the JSI HostObject as global.__TalaDB__
    taladb::TalaDBHostObject::install(rt, db);
}
