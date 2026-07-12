import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // TalaDB's browser build runs the engine in a worker against OPFS. These headers
  // are what the browser requires to hand out a SharedArrayBuffer / sync access
  // handle in a cross-origin-isolated context.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: { exclude: ['@taladb/web'] },
})
