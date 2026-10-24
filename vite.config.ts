import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defineConfig } from 'vite'

// The UI is served to Tauri's webview (see src-tauri/tauri.conf.json).
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // DEVOT_SENTRY_DSN turns on crash reporting (see src/renderer/src/crash.ts).
  // It comes from the environment or `.env.local` at the repository root.
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  envPrefix: ['VITE_', 'TAURI_ENV_', 'DEVOT_SENTRY_DSN'],
  // True only in the UI tests' build (vite.ui-test.config.ts): in-memory storage, no Tauri.
  // A define, not an env variable, so no .env file can turn it on; the release build fails
  // if the storage is in dist/ (scripts/sentry/ui.ts).
  define: { DEVOT_UI_TEST: 'false' },
  // Markdown parsing runs in a Web Worker, where the DOM builds of some
  // packages (they decode entities through `document`) fail.
  resolve: { conditions: ['worker', ...defaultClientConditions] },
  // Vite's dependency scan does not follow `new Worker(new URL(...))`, so a package only the
  // core worker imports was found at first load; Vite re-bundled and reloaded every page and a
  // cold start lost the first tests. Naming the worker pre-bundles it
  // (tests/scripts/vite-deps.test.ts); entries replace the default pages, so they stay listed.
  optimizeDeps: { entries: ['*.html', 'src/core.worker.ts'] },
  // ES module workers, so lazy imports (math, emoji, highlighting) become chunks. Shared code
  // goes to a chunk of its own, never the entry: WebKit runs the worker script a second time
  // when a chunk imports it, and that copy answers with E_CORE_NOT_READY
  // (tests/scripts/worker-chunks.test.ts).
  worker: {
    format: 'es',
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'core-shared', minShareCount: 2 }] } },
    },
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2023',
    // Source maps exist only for the Sentry upload (scripts/sentry/ui.ts) and are deleted before
    // the app embeds dist/.
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)),
        settings: fileURLToPath(new URL('src/renderer/settings.html', import.meta.url)),
        quickCapture: fileURLToPath(new URL('src/renderer/quick-capture.html', import.meta.url)),
        mermaid: fileURLToPath(new URL('src/renderer/mermaid.html', import.meta.url)),
        export: fileURLToPath(new URL('src/renderer/export.html', import.meta.url)),
      },
    },
  },
})
