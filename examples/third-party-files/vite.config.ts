import { resolve } from 'node:path'

export default {
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
}
