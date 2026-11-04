// The Mermaid frame (src/renderer/mermaid.html) is sandboxed, so its origin is opaque and every
// module script or dynamic import() it asks for is a CORS request from `null`, which Tauri's
// asset protocol refuses. It loads one classic script instead: mermaid-frame.ts built as an IIFE
// with its dynamic imports inlined. The bundle is built in memory, served by the dev server and
// emitted into the build, so nothing generated is written to the source tree.
import { resolve } from 'node:path'
import { build, type Plugin, type Rolldown } from 'vite'

export const MERMAID_FRAME_SCRIPT = 'mermaid-frame.js'

const entry = resolve(import.meta.dirname, '../../src/renderer/src/mermaid-frame.ts')

interface Bundle {
  code: string
  modules: Set<string>
}

/** The frame's script as one classic script: no import(), no import.meta, no top-level await. */
export async function buildMermaidFrame(): Promise<Bundle> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      write: false,
      target: 'es2023',
      minify: true,
      sourcemap: false,
      lib: { entry, formats: ['iife'], name: 'devotMermaidFrame', fileName: () => 'frame.js' },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => (output as Rolldown.RolldownOutput).output,
  )
  const chunks = outputs.filter((output) => output.type === 'chunk')
  const [chunk] = chunks
  if (!chunk || chunks.length !== 1) throw new Error('E_MERMAID_FRAME_BUNDLE')
  return { code: chunk.code, modules: new Set(chunk.moduleIds) }
}

export function mermaidFrame(): Plugin {
  let cached: Promise<Bundle> | undefined
  const bundle = () => (cached ??= buildMermaidFrame())
  return {
    name: 'devot-mermaid-frame',
    configureServer(server) {
      // Built ahead, so the first diagram does not wait seconds for the bundle.
      const warm = () => void bundle().catch(() => (cached = undefined))
      warm()
      server.watcher.on('change', (file) => {
        cached?.then(
          ({ modules }) => {
            if (!modules.has(file)) return
            cached = undefined
            warm()
          },
          () => (cached = undefined),
        )
      })
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${MERMAID_FRAME_SCRIPT}`) return next()
        bundle().then(({ code }) => {
          res.setHeader('content-type', 'text/javascript')
          res.setHeader('cache-control', 'no-cache')
          res.end(code)
        }, next)
      })
    },
    async generateBundle() {
      const { code } = await bundle()
      this.emitFile({ type: 'asset', fileName: MERMAID_FRAME_SCRIPT, source: code })
    },
  }
}
