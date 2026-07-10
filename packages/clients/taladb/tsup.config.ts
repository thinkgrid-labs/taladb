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
  //
  // `import.meta.url` appears in createBrowserDB / createInMemoryBrowserDB
  // which are dead code on React Native (detectPlatform() never returns
  // 'browser' there). We replace it at build time so Metro/Hermes never
  // sees the unsupported import.meta syntax.
  // -------------------------------------------------------------------------
  {
    entry: { 'index.react-native': 'src/index.react-native.ts' },
    format: ['esm'],
    outDir: 'dist',
    // @taladb/react-native is provided by the RN runtime — keep it external.
    // @taladb/node is stubbed inline (see plugin below) so Metro never sees
    // the specifier. noExternal overrides tsup's automatic peer-dep externalization.
    external: ['@taladb/react-native'],
    noExternal: ['@taladb/node'],
    esbuildOptions(options) {
      // createBrowserDB / createInMemoryBrowserDB use import.meta.url — they
      // are dead code on React Native but must not contain unsupported syntax.
      options.define = {
        ...options.define,
        'import.meta.url': '"react-native://unreachable"',
      }
    },
    esbuildPlugins: [
      {
        name: 'react-native-stubs',
        setup(build) {
          // Stub ./config → browser no-op (avoids js-yaml / node:* imports)
          const configStub = path.resolve(__dirname, 'src/config.browser.ts')
          build.onResolve({ filter: /\/config(\.ts)?$/ }, (args) => {
            if (args.importer.includes('index.react-native.ts') || args.importer.includes('index.ts')) {
              return { path: configStub }
            }
          })

          // Stub @taladb/node so Metro never sees the specifier.
          // createNodeDB (which uses it) is dead code on React Native —
          // detectPlatform() → 'react-native' — but Metro resolves every
          // import() specifier statically, even unreachable ones.
          // Using a real file path guarantees esbuild bundles the stub inline
          // regardless of tsup's automatic workspace-package externalization.
          const nodeStub = path.resolve(__dirname, 'src/stubs/node.ts')
          build.onResolve({ filter: /^@taladb\/node$/ }, () => ({ path: nodeStub }))
        },
      },
    ],
  },
])
