import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'dist',
  external: ['react', 'taladb'],
  // React Server Components: mark the whole hooks package as client-side so
  // Next.js apps can import it from any file without tripping the RSC
  // boundary (the SWR / react-query convention). Harmless everywhere else.
  banner: { js: "'use client';" },
})
