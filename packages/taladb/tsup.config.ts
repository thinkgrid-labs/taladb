import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
  esbuildOptions(options, context) {
    // import.meta.url is only used in browser code paths (createBrowserDB /
    // createInMemoryBrowserDB) which are never reached in CJS/Node.js context
    // — detectPlatform() returns 'node' there. Safe to silence.
    if (context.format === 'cjs') {
      options.logOverride = { 'empty-import-meta': 'silent' }
    }
  },
})
