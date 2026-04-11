---
title: React Native Guide
description: Use TalaDB in React Native apps for local-first document and vector storage with no server required.
---

# React Native

TalaDB runs natively on iOS and Android via a JSI integration — calls from JavaScript go directly into the Rust engine without bridge overhead or JSON serialisation on the hot path.

::: warning Beta — in progress
The React Native package is functional but full end-to-end setup (CocoaPods, Gradle AAR) is still being finalised. The API below is stable and reflects the final shape. Track progress on [GitHub](https://github.com/thinkgrid-labs/taladb).
:::

## Requirements

- React Native **0.73+** with New Architecture enabled
- Expo SDK **50+** (if using Expo)
- Xcode 15+ for iOS builds
- Android NDK r26+ for Android builds

## Installation

```bash
pnpm add taladb @taladb/react-native
```

### iOS

```bash
cd ios && pod install
```

### Android

No extra steps — Gradle links the native library automatically.

### Enable the New Architecture

TalaDB requires the New Architecture for its JSI integration.

**`android/gradle.properties`**
```properties
newArchEnabled=true
```

**`ios/Podfile`**
```ruby
use_framework! :static
```

## Quick start

Call `TalaDBModule.initialize` once at app startup — before any component tries to use the database.

```ts
// App.tsx
import { TalaDBModule } from '@taladb/react-native'
import { openDB } from 'taladb'

await TalaDBModule.initialize('myapp.db')

const db = await openDB('myapp.db')
const users = db.collection('users')

await users.insert({ name: 'Alice', createdAt: Date.now() })
const all = await users.find()
```

That's it. The `taladb` package detects React Native automatically — the same code you write for the browser or Node.js works here too.

## Full example

```tsx
// App.tsx
import React, { useEffect, useState } from 'react'
import { View, Text, Button, FlatList } from 'react-native'
import { TalaDBModule } from '@taladb/react-native'
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

## Vector search

TalaDB supports on-device semantic search — store embeddings from a local ML model (Core ML, TensorFlow Lite) and search them without any server.

```ts
interface Article {
  _id?: string
  title: string
  body: string
  embedding: number[]
}

const articles = db.collection<Article>('articles')
await articles.createVectorIndex('embedding', { dimensions: 384 })

// Insert with embedding from your on-device model
const embedding = await myModel.embed(content)
await articles.insert({ title, body: content, embedding })

// Semantic search
const queryVec = await myModel.embed(userQuery)
const results = await articles.findNearest('embedding', queryVec, 5)

results.forEach(({ document, score }) => {
  console.log(score.toFixed(3), document.title)
})

// Hybrid: combine vector ranking with a metadata filter
const filtered = await articles.findNearest('embedding', queryVec, 5, {
  category: 'faq',
})
```

## Where data is stored

| Platform | Location |
|---|---|
| iOS | `NSDocumentDirectory` (iCloud-excluded by default) |
| Android | `Context.getFilesDir()` (app-private, no permissions needed) |

No special permissions are required on either platform.

## Migrations

```ts
const db = await openDB('myapp.db', {
  migrations: [
    {
      version: 1,
      description: 'Add notes index',
      up: async (db) => {
        await db.collection('notes').createIndex('createdAt')
      },
    },
  ],
})
```

## Troubleshooting

**`__TalaDB__ JSI HostObject not found`**
`openDB` was called before `TalaDBModule.initialize` completed. Move `initialize` to the very top of your app entry point and `await` it before any database access.

**`New Architecture is not enabled`**
Set `newArchEnabled=true` in `android/gradle.properties` and add `use_framework! :static` to your `ios/Podfile`.

**Pod install fails on iOS**
Make sure Xcode command-line tools are active: `xcode-select --install`. Then re-run `pod install`.

## Current limitations

- **CocoaPods and Gradle packaging** — the native build pipeline is still being finalised. Pre-built binaries (`libtaladb.a` for iOS, `libtaladb.so` for Android) are not yet published to npm. To use TalaDB in React Native today you need to build the Rust libraries from source (see the [Contributing guide](https://github.com/thinkgrid-labs/taladb/blob/main/CONTRIBUTING.md)).
- **Expo Go** — not supported. You must use a custom dev client (`expo prebuild`).
- **HNSW vector index** — available and fully supported on React Native (runs natively on device threads).
- **Live queries (`subscribe`)** — polling-based on React Native; native file-watch push is planned for a future release.
