import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  envPrefix: ['VITE_', 'TAURI_ENV_', 'DEVOT_SENTRY_DSN'],
  // True only in the UI tests' build (vite.ui-test.config.ts): notes in an
  // in-memory storage, no Tauri behind the page. A define, not an env
  // variable, so no environment or `.env` file can turn it on here; the
  // app's builds leave that storage out entirely, and the release build
  // fails if it is there (scripts/sentry/ui.ts).
  define: { DEVOT_UI_TEST: 'false' },
  resolve: { conditions: ['worker', ...defaultClientConditions] },
  // Vite's dependency scan reads the pages but does not follow
  // `new Worker(new URL(...))`, so a package only the core worker imports was
  // found when the worker first loaded; Vite then re-bundled and reloaded
  // every open page, and a cold start (CI, a fresh checkout) lost the first
  // tests that way. Naming the worker pre-bundles everything before the first
  // load (tests/scripts/vite-deps.test.ts). Naming entries replaces the
  // default, the page files, so they stay listed.
  optimizeDeps: { entries: ['*.html', 'src/core.worker.ts'] },
  // ES module workers, so the worker's lazy imports (math, emoji, code
  // highlighting) become their own chunks. What such a chunk shares with the
  // worker's own code (the bundler's helpers included) goes to a chunk of its
  // own, never into the entry: WebKit runs the worker's script a second time
  // when a chunk imports it, and that copy answers the page's calls with
  // E_CORE_NOT_READY (tests/scripts/worker-chunks.test.ts).
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
    // Source maps are made only for upload to Sentry (scripts/sentry/ui.ts)
    // and deleted before the app embeds dist/; they never ship.
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)),
        settings: fileURLToPath(new URL('src/renderer/settings.html', import.meta.url)),
        mermaid: fileURLToPath(new URL('src/renderer/mermaid.html', import.meta.url)),
      },
    },
  },
})
