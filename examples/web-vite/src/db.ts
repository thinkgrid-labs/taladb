import { openDB } from 'taladb'
import type { Collection, Document } from 'taladb'

export interface Note extends Document {
  title: string
  body: string
  category: string
  tags: string[]
  createdAt: number
}

export interface Article extends Document {
  title: string
  body: string
  category: string
  embedding: number[]
}

export type NoteCollection = Collection<Note>
export type ArticleCollection = Collection<Article>

let _db: Awaited<ReturnType<typeof openDB>> | null = null

export async function initDB() {
  if (_db) return _db
  _db = await openDB('taladb-playground.db')

  // Idempotent index setup — safe to call on every open
  const notes = _db.collection('notes')
  await notes.createIndex('category')
  await notes.createIndex('createdAt')
  await notes.createIndex('_fts:body')

  const articles = _db.collection('articles')
  await articles.createIndex('category')
  await articles.createVectorIndex('embedding', { dimensions: 384 })

  return _db
}

export function db() {
  if (!_db) throw new Error('DB not initialised — call initDB() first')
  return _db
}

export const SEED_ARTICLES: Omit<Article, '_id' | 'embedding'>[] = [
  {
    title: 'Getting Started with Rust',
    body: 'Rust is a systems programming language focused on safety, speed, and concurrency. Its ownership model eliminates memory bugs at compile time without a garbage collector, making it ideal for performance-critical software.',
    category: 'rust',
  },
  {
    title: 'Rust Ownership and Borrowing',
    body: 'The ownership system in Rust ensures every value has a single owner. Borrowing allows references without transferring ownership. These rules prevent data races and use-after-free bugs entirely at compile time.',
    category: 'rust',
  },
  {
    title: 'Concurrent Programming in Rust',
    body: 'Rust makes concurrent code safe through its type system. The Send and Sync traits statically verify which types can be shared across threads, preventing data races that plague C and C++ programs.',
    category: 'rust',
  },
  {
    title: 'WebAssembly in the Browser',
    body: 'WebAssembly lets you run code written in Rust, C++, or Go at near-native speed inside the browser. Combined with JavaScript, it unlocks new categories of web applications like video editing, 3D engines, and local databases.',
    category: 'webassembly',
  },
  {
    title: 'OPFS: Persistent Storage for Web Apps',
    body: 'The Origin Private File System gives web apps low-level, synchronous file access from a Worker. It is dramatically faster than IndexedDB for large binary data and enables embedded databases like TalaDB to run at full speed in the browser.',
    category: 'webassembly',
  },
  {
    title: 'Building Local-First Applications',
    body: 'Local-first software keeps data on the user\'s device, working offline by default and syncing opportunistically. This architecture dramatically reduces latency, improves privacy, and eliminates dependency on backend availability.',
    category: 'databases',
  },
  {
    title: 'Vector Databases Explained',
    body: 'Vector databases store high-dimensional numeric representations (embeddings) of data and support similarity search. They are the backbone of semantic search, recommendation engines, and retrieval-augmented generation (RAG) systems.',
    category: 'databases',
  },
  {
    title: 'Hybrid Search: Filters + Vector Ranking',
    body: 'Hybrid search combines structured metadata filters with vector similarity ranking in a single query. For example, find the most semantically relevant English support articles, without two round trips to the database.',
    category: 'databases',
  },
  {
    title: 'ACID Transactions Explained',
    body: 'ACID stands for Atomicity, Consistency, Isolation, and Durability. These properties guarantee that database operations are processed reliably, even in the event of errors, power failures, or concurrent access.',
    category: 'databases',
  },
  {
    title: 'Embeddings and Semantic Search',
    body: 'Text embeddings are dense numeric vectors that encode the semantic meaning of text. Similar sentences produce similar vectors. Semantic search uses these vectors to find conceptually related results even when exact keywords do not match.',
    category: 'ai',
  },
  {
    title: 'Running ML Models in the Browser',
    body: 'Transformers.js brings Hugging Face transformer models to the browser using WebAssembly and ONNX Runtime. Models run entirely client-side, with no data sent to a server, enabling private, offline-capable AI features.',
    category: 'ai',
  },
  {
    title: 'Retrieval-Augmented Generation (RAG)',
    body: 'RAG enhances large language models by retrieving relevant context from a knowledge base before generating a response. A vector index finds the most semantically similar documents, which are injected into the LLM prompt.',
    category: 'ai',
  },
  {
    title: 'React Hooks Deep Dive',
    body: 'React Hooks let functional components use state and lifecycle features. useState manages local state, useEffect handles side effects, and useCallback memoises functions. Custom hooks encapsulate reusable stateful logic cleanly.',
    category: 'javascript',
  },
  {
    title: 'TypeScript Advanced Types',
    body: 'TypeScript\'s advanced types include mapped types, conditional types, template literal types, and infer. Together they enable expressive, type-safe abstractions that catch errors at compile time rather than runtime.',
    category: 'javascript',
  },
  {
    title: 'JavaScript Performance Optimization',
    body: 'Key JavaScript performance techniques include avoiding layout thrashing, using requestAnimationFrame for animations, debouncing expensive event handlers, and leveraging Web Workers to keep the main thread responsive.',
    category: 'javascript',
  },
]
