#!/usr/bin/env bash
# Build the Rust C FFI crate for iOS targets and produce:
#   ios/TalaDBFfi.xcframework  — used by the podspec (Xcode 12+)
#   ios/libtaladb_ffi.a        — fat static lib (fallback for manual linking)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUST_DIR="$PACKAGE_DIR/rust"
OUT_DIR="$PACKAGE_DIR/ios"

# Ensure iOS targets are installed
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

echo "Building for aarch64-apple-ios (device)…"
cargo build --manifest-path "$RUST_DIR/Cargo.toml" \
    --target aarch64-apple-ios --release

echo "Building for aarch64-apple-ios-sim (Apple Silicon simulator)…"
cargo build --manifest-path "$RUST_DIR/Cargo.toml" \
    --target aarch64-apple-ios-sim --release

echo "Building for x86_64-apple-ios (Intel simulator)…"
cargo build --manifest-path "$RUST_DIR/Cargo.toml" \
    --target x86_64-apple-ios --release

CARGO_TARGET="$(cargo metadata --manifest-path "$RUST_DIR/Cargo.toml" \
    --no-deps --format-version 1 | python3 -c \
    'import sys,json; print(json.load(sys.stdin)["target_directory"])')"

# Merge the two simulator slices first
lipo -create \
    "$CARGO_TARGET/aarch64-apple-ios-sim/release/libtaladb_ffi.a" \
    "$CARGO_TARGET/x86_64-apple-ios/release/libtaladb_ffi.a" \
    -output "$CARGO_TARGET/libtaladb_ffi_sim.a"

# Create xcframework (device + simulator) — preferred over fat .a for Xcode 12+
rm -rf "$OUT_DIR/TalaDBFfi.xcframework"
xcodebuild -create-xcframework \
    -library "$CARGO_TARGET/aarch64-apple-ios/release/libtaladb_ffi.a" \
    -headers "$PACKAGE_DIR/cpp" \
    -library "$CARGO_TARGET/libtaladb_ffi_sim.a" \
    -headers "$PACKAGE_DIR/cpp" \
    -output "$OUT_DIR/TalaDBFfi.xcframework"

# Also produce a flat fat .a for pods that don't support xcframework
lipo -create \
    "$CARGO_TARGET/aarch64-apple-ios/release/libtaladb_ffi.a" \
    "$CARGO_TARGET/libtaladb_ffi_sim.a" \
    -output "$OUT_DIR/libtaladb_ffi.a"

echo "Done → $OUT_DIR/libtaladb_ffi.a and $OUT_DIR/TalaDBFfi.xcframework"
