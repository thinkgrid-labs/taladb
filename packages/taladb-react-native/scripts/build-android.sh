#!/usr/bin/env bash
# Build the Rust C FFI crate for Android ABI targets using cargo-ndk.
# Requires: cargo install cargo-ndk  and  NDK installed (ANDROID_NDK_HOME set).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$PACKAGE_DIR/rust"
JNI_LIBS="$PACKAGE_DIR/android/src/main/jniLibs"

ABIS=("arm64-v8a" "armeabi-v7a" "x86_64" "x86")
TRIPLES=("aarch64-linux-android" "armv7-linux-androideabi" "x86_64-linux-android" "i686-linux-android")

# Ensure Rust targets are installed
for triple in "${TRIPLES[@]}"; do
    rustup target add "$triple"
done

for i in "${!ABIS[@]}"; do
    abi="${ABIS[$i]}"
    triple="${TRIPLES[$i]}"
    echo "Building for $abi ($triple)…"

    cargo ndk \
        --manifest-path "$RUST_DIR/Cargo.toml" \
        --target "$abi" \
        --platform 21 \
        -- build --release

    CARGO_TARGET="$(cargo metadata --manifest-path "$RUST_DIR/Cargo.toml" \
        --no-deps --format-version 1 | python3 -c \
        'import sys,json; print(json.load(sys.stdin)["target_directory"])')"

    mkdir -p "$JNI_LIBS/$abi"
    cp "$CARGO_TARGET/$triple/release/libtaladb_ffi.so" "$JNI_LIBS/$abi/"
    echo "  → $JNI_LIBS/$abi/libtaladb_ffi.so"
done

echo "Done. All .so files are in $JNI_LIBS/"
