import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { server: 'src/server.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    external: ['taladb'],
  },
  {
    entry: { client: 'src/client.tsx' },
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    external: ['react', 'taladb', '@taladb/react'],
    // RSC boundary: the client entry is browser-side by definition.
    banner: { js: "'use client';" },
  },
])
