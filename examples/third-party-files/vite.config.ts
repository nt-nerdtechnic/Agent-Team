import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, 'dist/package/frontend'),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/main.ts'),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
})
