# React Native

TalaDB integrates with React Native through a [JSI (JavaScript Interface)](https://reactnative.dev/docs/the-new-architecture/landing-page) HostObject. Unlike a bridge-based module, JSI allows synchronous, zero-serialisation calls from JavaScript directly into the Rust engine — no JSON serialisation on the hot path, no async roundtrip for reads.

## Architecture

```
React Native (JS thread)
        │  JSI direct call (synchronous)
        ▼
ZeroDBHostObject  (C++ HostObject — cpp/ZeroDBHostObject.cpp)
        │  C FFI
        ▼
taladb-ffi  (Rust cdylib — no_mangle extern "C")
        │
        ▼
taladb-core (Rust) + redb (file in app Documents dir)
```

The HostObject is installed into the JSI runtime once at app startup by the native TurboModule. After that, all JavaScript calls go directly through JSI without touching the bridge.

## Status

::: warning Active development
The React Native integration has a complete C FFI layer (`taladb-ffi`), C++ HostObject scaffold, and iOS / Android TurboModule stubs. Full end-to-end integration (Xcode build phases, Gradle AAR packaging) is in progress. The API documented here reflects the intended final shape.
:::

## Prerequisites

- React Native 0.73+ (New Architecture enabled)
- Expo SDK 50+ (if using Expo)
- Xcode 15+ (iOS)
- Android NDK r26+ (Android)
- Rust toolchain with iOS / Android targets installed:

```bash
rustup target add aarch64-apple-ios x86_64-apple-ios   # iOS
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android  # Android
```

## Installation

```bash
npm install taladb taladb-react-native
# or
pnpm add taladb taladb-react-native
```

### iOS

```bash
cd ios && pod install
```

The pod install step picks up `taladb-react-native.podspec`, which includes the pre-compiled `libzerodb.a` universal static library and the C++ HostObject sources.

### Android

The Gradle build system automatically links `libtaladb.so` for the supported ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`).

## Enabling the New Architecture

TalaDB's JSI integration requires the New Architecture. In `android/gradle.properties`:

```properties
newArchEnabled=true
```

In `ios/Podfile`:

```ruby
use_framework! :static
```

## Initialising the database

Call `TalaDBModule.initialize` as early as possible in your app's entry point — before any component tries to use the database.

```ts
// App.tsx  (or index.js)
import { TalaDBModule } from 'taladb-react-native'

await TalaDBModule.initialize('myapp.db')
```

This call:
1. Resolves the absolute path for `myapp.db` inside the app's Documents directory (iOS) or files directory (Android).
2. Opens (or creates) the redb database at that path.
3. Installs the `__TalaDB__` JSI HostObject into the JS runtime.

The database path is sandboxed to the app's private storage — no special permissions are required.

## Using the database

After `initialize`, use `openDB` from `taladb` exactly as you would in a browser or Node.js app:

```ts
import { openDB } from 'taladb'

const db = await openDB('myapp.db')
```

The `taladb` package detects React Native by the presence of `globalThis.nativeCallSyncHook` and routes calls through the JSI HostObject instead of WASM or the native module.

## Full example

```tsx
// App.tsx
import React, { useEffect, useState } from 'react'
import { View, Text, Button, FlatList } from 'react-native'
import { TalaDBModule } from 'taladb-react-native'
import { openDB, type Collection } from 'taladb'

interface Note {
  _id?: string
  text: string
  createdAt: number
}

let notes: Collection<Note>

export default function App() {
  const [items, setItems] = useState<Note[]>([])

  useEffect(() => {
    async function init() {
      await TalaDBModule.initialize('notes.db')
      const db = await openDB('notes.db')
      notes = db.collection<Note>('notes')
      await notes.createIndex('createdAt')
      setItems(await notes.find())
    }
    init()
  }, [])

  async function addNote() {
    await notes.insert({ text: `Note ${Date.now()}`, createdAt: Date.now() })
    setItems(await notes.find())
  }

  return (
    <View style={{ flex: 1, padding: 40 }}>
      <Button title="Add Note" onPress={addNote} />
      <FlatList
        data={items}
        keyExtractor={(item) => item._id!}
        renderItem={({ item }) => <Text>{item.text}</Text>}
      />
    </View>
  )
}
```

## Migrations

```ts
const db = await openDB('myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Create notes index',
      up: async (db) => {
        await db.collection('notes').createIndex('createdAt')
      },
    },
  ],
})
```

## Data persistence and location

| Platform | Location |
|---|---|
| iOS | `NSDocumentDirectory` (iCloud-excluded by default) |
| Android | `Context.getFilesDir()` (app-private, no permissions needed) |

Data is not backed up to iCloud or Google Drive by default. To enable backup, configure `NSFileProtection` (iOS) or Android Backup rules as appropriate for your app.

## Exporting and restoring snapshots

```ts
const bytes = await db.exportSnapshot()
// Transfer bytes over your sync layer, then restore on another device:
const db2 = await Database.restoreFromSnapshot(bytes)
```

## Live queries

```ts
const handle = db.collection<Note>('notes').watch({})

async function streamUpdates() {
  for await (const snapshot of handle) {
    setItems(snapshot)
  }
}

streamUpdates()
```

## Building the Rust libraries

### iOS

```bash
cd packages/taladb-react-native/rust

# Build for device and simulator
cargo build --release --target aarch64-apple-ios
cargo build --release --target x86_64-apple-ios

# Create a universal static library
lipo -create \
  ../../target/aarch64-apple-ios/release/libtaladb_ffi.a \
  ../../target/x86_64-apple-ios/release/libtaladb_ffi.a \
  -output ios/libtaladb.a
```

### Android

```bash
cd packages/taladb-react-native/rust

cargo build --release --target aarch64-linux-android
cargo build --release --target armv7-linux-androideabi
cargo build --release --target x86_64-linux-android
```

The Gradle build picks up the `.so` files from `android/src/main/jniLibs/`.

## Troubleshooting

**`__TalaDB__ JSI HostObject not found`**
You called `openDB` before `TalaDBModule.initialize` completed. Move `initialize` to the earliest possible point in your app startup and await it before rendering any component that accesses the database.

**`New Architecture is not enabled`**
Set `newArchEnabled=true` in `android/gradle.properties` and ensure `use_framework! :static` is in your `ios/Podfile`.

**Rust build errors on iOS**
Make sure the iOS targets are installed: `rustup target add aarch64-apple-ios x86_64-apple-ios` and that Xcode's command-line tools are active: `xcode-select --install`.
