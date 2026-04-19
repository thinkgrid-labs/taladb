import path from 'node:path'
import { defineConfig } from 'tsup'

export default defineConfig([
  // -------------------------------------------------------------------------
  // Node.js build — CJS + ESM with full config loader (js-yaml included)
  // -------------------------------------------------------------------------
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    outDir: 'dist',
    external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
    esbuildOptions(options, context) {
      if (context.format === 'cjs') {
        // import.meta.url is only used in browser code paths — safe to silence.
        options.logOverride = { 'empty-import-meta': 'silent' }
      }
    },
  },

  // -------------------------------------------------------------------------
  // Browser build — ESM only, js-yaml and Node.js fs/path imports eliminated
  //
  // An esbuild plugin redirects `./config` imports to `./config.browser.ts`,
  // a stub with a no-op loadConfig and no dynamic imports. This keeps js-yaml
  // and node:* specifiers out of the browser bundle entirely.
  // Bundlers (Vite, webpack) use this file via the `browser` export condition.
  // -------------------------------------------------------------------------
  {
    entry: { 'index.browser': 'src/index.ts' },
    format: ['esm'],
    outDir: 'dist',
    external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
    esbuildPlugins: [
      {
        name: 'browser-config-stub',
        setup(build) {
          // Redirect any import of the config module to the browser stub.
          const stub = path.resolve(__dirname, 'src/config.browser.ts')
          build.onResolve({ filter: /\/config(\.ts)?$/ }, (args) => {
            if (args.importer.includes('index.ts') || args.importer.includes('index.browser.ts')) {
              return { path: stub }
            }
          })
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // React Native build — ESM only, Metro bundler uses this via the
  // `react-native` export condition. All platform adapters are external so
  // Metro never tries to bundle @taladb/web or @taladb/node.
  // -------------------------------------------------------------------------
  {
    entry: { 'index.react-native': 'src/index.react-native.ts' },
    format: ['esm'],
    outDir: 'dist',
    external: ['@taladb/web', '@taladb/node', '@taladb/react-native'],
    esbuildPlugins: [
      {
        name: 'react-native-config-stub',
        setup(build) {
          const stub = path.resolve(__dirname, 'src/config.browser.ts')
          build.onResolve({ filter: /\/config(\.ts)?$/ }, (args) => {
            if (args.importer.includes('index.react-native.ts') || args.importer.includes('index.ts')) {
              return { path: stub }
            }
          })
        },
      },
    ],
  },
])
