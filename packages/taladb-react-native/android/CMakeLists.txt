cmake_minimum_required(VERSION 3.22)
project(taladb_jsi)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Root of the taladb-react-native package
get_filename_component(PACKAGE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

# Pre-built Rust static library (built by cargo ndk, copied by build.gradle)
set(TALADB_FFI_LIB
    "${CMAKE_CURRENT_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI}/libtaladb_ffi.so")

# ---------------------------------------------------------------------------
# React Native JSI headers
# React Native ships jsi/ headers inside node_modules — resolve from package root.
# ---------------------------------------------------------------------------
find_package(ReactAndroid REQUIRED CONFIG)

# ---------------------------------------------------------------------------
# taladb_ffi shared library (Rust pre-built, imported target)
# ---------------------------------------------------------------------------
add_library(taladb_ffi SHARED IMPORTED)
set_target_properties(taladb_ffi PROPERTIES
    IMPORTED_LOCATION "${TALADB_FFI_LIB}")

# ---------------------------------------------------------------------------
# taladb_jsi — C++ JSI HostObject, compiled into a thin shared library that
# the Kotlin module loads via System.loadLibrary("taladb_jsi").
# ---------------------------------------------------------------------------
add_library(taladb_jsi SHARED
    "${PACKAGE_ROOT}/cpp/TalaDBHostObject.cpp"
    "${PACKAGE_ROOT}/cpp/TalaDBJni.cpp"
)

target_include_directories(taladb_jsi PRIVATE
    "${PACKAGE_ROOT}/cpp"
)

target_link_libraries(taladb_jsi
    taladb_ffi
    ReactAndroid::jsi
    android
    log
)
