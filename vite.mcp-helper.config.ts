import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// devot-mcp as one CommonJS file for a Node single executable: nothing is left outside the bundle,
// and SQLite is Node's own (src/mcp/nodeSqlite.ts), so the helper loads no addon.
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  resolve: {
    alias: { 'better-sqlite3': resolve(import.meta.dirname, 'src/mcp/nodeSqlite.ts') },
  },
  ssr: { noExternal: true },
  build: {
    ssr: 'src/mcp/main.ts',
    outDir: 'dist-mcp-helper',
    emptyOutDir: true,
    target: 'node24',
    minify: true,
    sourcemap: false,
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'devot-mcp.cjs' } },
  },
})
