import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    outDir: 'dist',
    external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: false,
    outDir: 'dist',
    external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
    esbuildOptions(options) {
      // import.meta.url is only used in browser code paths (createBrowserDB /
      // createInMemoryBrowserDB) which are never reached in a CJS/Node.js
      // context — detectPlatform() returns 'node' there. Safe to silence.
      options.logOverride = { 'empty-import-meta': 'silent' }
    },
  },
])
