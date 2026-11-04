import { mergeConfig } from 'vite'
import app from './vite.config.ts'

// Only the UI tests use this build: in-memory storage (src/renderer/src/storage/memory.ts), no Tauri.
// The minifier keeps function names, so the render counts (tests/ui/renders.ts) find components by
// name; it still mangles everything else, as in the app's build.
const keepNames = { function: true, class: false }
export default mergeConfig(app, {
  define: { DEVOT_UI_TEST: 'true' },
  build: {
    rollupOptions: { output: { minify: { compress: { keepNames }, mangle: { keepNames } } } },
  },
})
