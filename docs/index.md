---
layout: home
title: TalaDB — Local-First Document Database
description: Open-source document database built in Rust. MongoDB-like API for browser (WASM + OPFS), Node.js, and React Native. Zero cloud, zero GC, fully offline.

hero:
  tagline: Zero cloud. Zero GC. Zero compromise. One API across browser, React Native, and Node.js.
  actions:
    - theme: brand
      text: Get Started
      link: /introduction
    - theme: alt
      text: View on GitHub
      link: https://github.com/thinkgrid-labs/taladb

features:
  - icon: 🦀
    title: Rust Core
    details: The engine is written in Rust and compiles to a sub-400 KB WASM bundle, a native .node module, and a static library for React Native — the same code on every platform.
  - icon: 📦
    title: MongoDB-like API
    details: Familiar find, insert, update, delete with $eq, $gt, $in, $and, $or and more. Fully typed with TypeScript generics.
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
---
