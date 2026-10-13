import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defineConfig } from 'vite'

// The UI is served to Tauri's webview: the dev server for `tauri dev`,
// `dist/` for builds (see src-tauri/tauri.conf.json).
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // DEVOT_SENTRY_DSN turns on crash reporting (see src/renderer/src/crash.ts).
  // It comes from the environment or `.env.local` at the repository root.
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  envPrefix: ['VITE_', 'TAURI_ENV_', 'DEVOT_SENTRY_DSN'],
  // True only in the UI tests' build (vite.ui-test.config.ts): notes in an
  // in-memory storage, no Tauri behind the page. A define, not an env
  // variable, so no environment or `.env` file can turn it on here; the
  // app's builds leave that storage out entirely, and the release build
  // fails if it is there (scripts/sentry/ui.ts).
  define: { DEVOT_UI_TEST: 'false' },
  // Markdown parsing runs in a Web Worker, where the DOM builds of some
  // packages (they decode entities through `document`) fail.
  resolve: { conditions: ['worker', ...defaultClientConditions] },
  // Vite's dependency scan reads the pages but does not follow
  // `new Worker(new URL(...))`, so a package only the core worker imports was
  // found when the worker first loaded; Vite then re-bundled and reloaded
  // every open page, and a cold start (CI, a fresh checkout) lost the first
  // tests that way. Naming the worker pre-bundles everything before the first
  // load (tests/scripts/vite-deps.test.ts). Naming entries replaces the
  // default, the page files, so they stay listed.
  optimizeDeps: { entries: ['*.html', 'src/core.worker.ts'] },
  // ES module workers, so the worker's lazy imports (math, emoji) become
  // their own chunks.
  worker: { format: 'es' },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'es2023',
    // Source maps are made only for upload to Sentry (scripts/sentry/ui.ts)
    // and deleted before the app embeds dist/; they never ship.
    sourcemap: false,
    // The main window, the Settings window and the diagram frame.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('src/renderer/index.html', import.meta.url)),
        settings: fileURLToPath(new URL('src/renderer/settings.html', import.meta.url)),
        // The hidden frame that draws Mermaid diagrams (see preview/mermaid.ts).
        mermaid: fileURLToPath(new URL('src/renderer/mermaid.html', import.meta.url)),
      },
    },
  },
})
