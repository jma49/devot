import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defaultClientConditions, defineConfig } from 'vite'
import { mermaidFrame } from './scripts/vite/mermaid-frame.ts'

/** Whether a chain of static imports leads from the build's entry to `id`, which is not the entry. */
function loadsWithEntry(
  id: string,
  getModuleInfo: (id: string) => { isEntry: boolean; importers: string[] } | null,
): boolean {
  if (getModuleInfo(id)?.isEntry) return false
  const seen = new Set([id])
  const queue = [id]
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const info = getModuleInfo(next)
    if (info?.isEntry) return true
    for (const importer of info?.importers ?? []) {
      if (!seen.has(importer)) {
        seen.add(importer)
        queue.push(importer)
      }
    }
  }
  return false
}

// The UI is served to Tauri's webview (see src-tauri/tauri.conf.json).
export default defineConfig({
  root: 'src/renderer',
  plugins: [react(), mermaidFrame()],
  clearScreen: false,
  // A phone reaches this Mac by its network address, which `tauri ios dev` passes here.
  server: { host: process.env.TAURI_DEV_HOST || false, port: 5173, strictPort: true },
  // DEVOT_SENTRY_DSN turns on crash reporting (see src/renderer/src/crash.ts).
  // It comes from the environment or `.env.local` at the repository root.
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  envPrefix: ['VITE_', 'TAURI_ENV_', 'DEVOT_SENTRY_DSN'],
  // True only in the UI tests' build (vite.ui-test.config.ts): in-memory storage, no Tauri.
  // A define, not an env variable, so no .env file can turn it on; the release build fails
  // if the storage is in dist/ (scripts/sentry/ui.ts).
  // DEVOT_SPIKES (build.d.ts) follows Tauri's debug flag, and a release build fails if the probes are in dist/.
  define: {
    DEVOT_UI_TEST: 'false',
    DEVOT_SPIKES: JSON.stringify(process.env['TAURI_ENV_DEBUG'] === 'true'),
  },
  // The CSS minifier would write `rgb(… / 0.7)` as #rrggbbaa, rounding alpha to 1/255 steps, so
  // painted colours would drift from the tokens (tests/scripts/css-minify.test.ts). 16384 is
  // lightningcss's Features.HexAlphaColors; lightningcss comes with Vite, not as our dependency.
  css: { lightningcss: { include: 16384 } },
  // Markdown parsing runs in a Web Worker, where the DOM builds of some
  // packages (they decode entities through `document`) fail.
  resolve: { conditions: ['worker', ...defaultClientConditions] },
  // Vite's dependency scan does not follow `new Worker(new URL(...))`, so a package only the
  // core worker imports was found at first load; Vite re-bundled and reloaded every page and a
  // cold start lost the first tests. Naming the worker pre-bundles it
  // (tests/scripts/vite-deps.bench.test.ts); entries replace the default pages, so they stay listed.
  optimizeDeps: { entries: ['*.html', 'src/core.worker.ts'] },
  // ES module workers, so lazy imports (math, emoji, highlighting, sync, import) become chunks.
  // No chunk may import the entry: WebKit runs the worker script a second time when one does,
  // and that copy answers with E_CORE_NOT_READY (tests/scripts/worker-chunks.bench.test.ts).
  // So the entry is a facade, everything it loads statically goes to `core-shared`, and what
  // only lazy chunks share to `core-lazy`.
  worker: {
    format: 'es',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: (id, ctx) =>
                loadsWithEntry(id, (other) => ctx.getModuleInfo(other)) ? 'core-shared' : null,
              priority: 2,
            },
            { name: 'core-lazy', minShareCount: 2, priority: 1 },
          ],
        },
      },
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
        note: fileURLToPath(new URL('src/renderer/note.html', import.meta.url)),
        mermaid: fileURLToPath(new URL('src/renderer/mermaid.html', import.meta.url)),
        export: fileURLToPath(new URL('src/renderer/export.html', import.meta.url)),
      },
    },
  },
})
