import { defineConfig } from 'vite'

// devot-mcp: one ES module for Node, run as `node dist-mcp/devot-mcp.mjs`.
// Everything is bundled (the core, Yjs, the MCP SDK, the migrations) except
// better-sqlite3, a native module loaded from node_modules. It is not part
// of the app bundle (Tauri ships `dist/` only).
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  ssr: { noExternal: true, external: ['better-sqlite3'] },
  build: {
    ssr: 'src/mcp/main.ts',
    outDir: 'dist-mcp',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: ['better-sqlite3'],
      output: {
        format: 'es',
        entryFileNames: 'devot-mcp.mjs',
        banner: '#!/usr/bin/env node',
      },
    },
  },
})
