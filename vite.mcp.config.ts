import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { npmManifest, npmReadme, type RootPackage } from './src/mcp/npmPackage'

/** Writes the npm package's manifest, README and licence beside the bundle (src/mcp/npmPackage.ts). */
function npmPackage(): Plugin {
  return {
    name: 'devot-mcp-package',
    generateBundle() {
      const root = JSON.parse(
        readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'),
      ) as RootPackage
      const files = {
        'package.json': `${JSON.stringify(npmManifest(root), null, 2)}\n`,
        'README.md': npmReadme(),
        LICENSE: readFileSync(resolve(import.meta.dirname, 'LICENSE'), 'utf8'),
      }
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source })
      }
    },
  }
}

// devot-mcp: one ES module for Node, everything bundled except better-sqlite3 (native, loaded from
// node_modules; not in the app bundle, since Tauri ships `dist/` only).
export default defineConfig({
  publicDir: false,
  clearScreen: false,
  logLevel: 'warn',
  plugins: [npmPackage()],
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
