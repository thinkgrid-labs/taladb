---
layout: home
title: TalaDB — Embedded Document & Vector Database
description: Open-source embedded database built in Rust. MongoDB-like document queries and on-device vector similarity search — browser (WASM + OPFS), Node.js, and React Native. No cloud required.

hero:
  tagline: Documents and vectors, on device. The embedded database for the AI era.
  actions:
    - theme: brand
      text: Get Started
      link: /introduction
    - theme: alt
      text: Live Demo
      link: https://taladb-playground.vercel.app/
    - theme: alt
      text: View on GitHub
      link: https://github.com/thinkgrid-labs/taladb
    - theme: alt
      text: Sponsor
      link: https://github.com/sponsors/thinkgrid-labs

features:
  - icon: 🧠
    title: Vector Search
    details: On-device similarity search using cosine, dot, or euclidean metrics. Combine with metadata filters in one query — find the 5 most relevant documents for a given embedding without a cloud round-trip.
  - icon: 🦀
    title: Rust Core
    details: The engine is written in Rust and compiles to a sub-400 KB WASM bundle, a native .node module, and a static library for React Native — the same code on every platform.
  - icon: 📦
    title: MongoDB-like API
    details: Familiar find, insert, update, delete with $eq, $gt, $in, $and, $or and more. Fully typed with TypeScript generics — including vector index methods.
  - icon: ⚡
    title: Secondary Indexes
    details: Type-safe B-tree indexes with O(log n) range scans. The query planner picks the best index automatically.
  - icon: 🔒
    title: ACID Transactions
    details: Powered by redb — a pure-Rust B-tree storage engine. Every write is atomic, consistent, isolated, and durable.
  - icon: 📡
    title: Live Queries
    details: Subscribe to a collection with a filter and receive a fresh snapshot after every write — without polling.
  - icon: 🔐
    title: Encryption at Rest
    details: Wrap any backend with EncryptedBackend for transparent AES-GCM-256 encryption. Keys derived via PBKDF2-HMAC-SHA256.
  - icon: 🌐
    title: Works Everywhere
    details: Browser (WASM + OPFS SharedWorker), Node.js (napi-rs), and React Native (JSI). One package, one API, zero platform branches.
---
