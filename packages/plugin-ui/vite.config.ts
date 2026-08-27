import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const packageRoot = __dirname

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: resolve(packageRoot, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: {
        index: resolve(packageRoot, 'src/index.ts'),
        'shared/index': resolve(packageRoot, 'src/shared/index.ts'),
        'foundation/index': resolve(packageRoot, 'src/foundation/index.ts'),
        styles: resolve(packageRoot, 'src/styles.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['@navide/plugin-sdk', 'vue', 'vue-i18n'],
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.name === 'style.css' ? 'styles.css' : 'assets/[name][extname]',
      },
    },
  },
})
