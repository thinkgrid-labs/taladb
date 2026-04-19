#!/usr/bin/env bash
# dev-playground-rn.sh
#
# Patches taladb-mobile-playground's node_modules in-place with the local
# source so you can test Android/iOS changes without publishing to npm.
#
# The pre-built libtaladb_ffi.so files inside node_modules are preserved —
# they are not present in the source tree and must be built separately via
# scripts/build-android.sh if you change any Rust code.
#
# Usage:
#   bash scripts/dev-playground-rn.sh          # patch only
#   bash scripts/dev-playground-rn.sh --clean  # also wipe Gradle CMake cache
#
# Requirements: pnpm, node

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLAYGROUND="$REPO/../taladb-mobile-playground"
CLEAN=false

for arg in "$@"; do
  case $arg in
    --clean) CLEAN=true ;;
  esac
done

if [ ! -d "$PLAYGROUND" ]; then
  echo "ERROR: taladb-mobile-playground not found at $PLAYGROUND"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Build TypeScript packages
# ---------------------------------------------------------------------------

echo "==> Building TypeScript (taladb)..."
(cd "$REPO/packages/taladb" && pnpm exec tsup)

echo "==> Building React hooks (@taladb/react)..."
(cd "$REPO/packages/taladb-react" && pnpm exec tsup)

# ---------------------------------------------------------------------------
# 2. Patch playground node_modules
# ---------------------------------------------------------------------------

echo "==> Patching playground node_modules..."

# taladb — dist/, src/, package.json (package.json carries exports/react-native condition)
TALADB_NM="$PLAYGROUND/node_modules/taladb"
rm -rf "$TALADB_NM/dist" "$TALADB_NM/src"
cp -r "$REPO/packages/taladb/dist"         "$TALADB_NM/dist"
cp -r "$REPO/packages/taladb/src"          "$TALADB_NM/src"
cp    "$REPO/packages/taladb/package.json"  "$TALADB_NM/package.json"

# @taladb/react — dist/, package.json
REACT_NM="$PLAYGROUND/node_modules/@taladb/react"
rm -rf "$REACT_NM/dist"
cp -r "$REPO/packages/taladb-react/dist"         "$REACT_NM/dist"
cp    "$REPO/packages/taladb-react/package.json"  "$REACT_NM/package.json"

# @taladb/react-native — src/, cpp/, android/ (without jniLibs), package.json, podspec
#
# jniLibs/ contains the pre-built libtaladb_ffi.so files. They don't exist
# in the source tree so we preserve whatever is already installed.
RN_NM="$PLAYGROUND/node_modules/@taladb/react-native"

rm -rf "$RN_NM/src"
cp -r "$REPO/packages/taladb-react-native/src" "$RN_NM/src"

rm -rf "$RN_NM/cpp"
cp -r "$REPO/packages/taladb-react-native/cpp" "$RN_NM/cpp"

# android/ — sync everything except src/main/jniLibs
ANDROID_SRC="$REPO/packages/taladb-react-native/android"
ANDROID_NM="$RN_NM/android"

cp "$ANDROID_SRC/CMakeLists.txt"                       "$ANDROID_NM/CMakeLists.txt"
cp "$ANDROID_SRC/build.gradle"                         "$ANDROID_NM/build.gradle"
cp "$ANDROID_SRC/src/main/AndroidManifest.xml"         "$ANDROID_NM/src/main/AndroidManifest.xml"
cp -r "$ANDROID_SRC/src/main/java"                     "$ANDROID_NM/src/main/"

cp "$REPO/packages/taladb-react-native/package.json"                   "$RN_NM/package.json"
cp "$REPO/packages/taladb-react-native/taladb-react-native.podspec"    "$RN_NM/taladb-react-native.podspec"

# ---------------------------------------------------------------------------
# 3. Clear Gradle CMake cache (required when CMakeLists.txt or cpp/ changes)
# ---------------------------------------------------------------------------

if [ "$CLEAN" = true ]; then
  echo "==> Clearing Gradle CMake cache..."
  rm -rf "$PLAYGROUND/android/.cxx"
  echo "    Done. Next build will re-run CMake configuration."
fi

echo ""
echo "Done. Run the playground:"
echo "  cd $PLAYGROUND && yarn android"
echo ""
echo "Tip: if you changed CMakeLists.txt or cpp/ files, use --clean to force"
echo "     Gradle to re-run CMake: bash scripts/dev-playground-rn.sh --clean"
