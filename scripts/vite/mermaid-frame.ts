// The Mermaid frame (src/renderer/mermaid.html) is sandboxed, so its origin is opaque and every
// module script or dynamic import() it asks for is a CORS request from `null`, which Tauri's
// asset protocol refuses. It loads classic scripts instead: mermaid-frame.ts, and each diagram
// engine when a diagram first needs it, every one built as an IIFE with its dynamic imports
// inlined. The bundles are built in memory, served by the dev server and emitted into the build,
// so nothing generated is written to the source tree.
import { resolve } from 'node:path'
import { build, type Plugin, type Rolldown } from 'vite'
import {
  DIAGRAM_ENGINES,
  engineEntry,
  engineScript,
  MERMAID_FRAME_ENTRY,
  MERMAID_FRAME_SCRIPT,
} from './mermaid-frame-entry.ts'

export { DIAGRAM_ENGINES, engineScript, MERMAID_FRAME_SCRIPT }

const repository = resolve(import.meta.dirname, '../..')

/** Each script the frame loads, by its published name, and the module it is built from. */
const SCRIPTS = new Map([
  [MERMAID_FRAME_SCRIPT, MERMAID_FRAME_ENTRY],
  ...DIAGRAM_ENGINES.map((engine) => [engineScript(engine), engineEntry(engine)] as const),
])

interface Bundle {
  code: string
  modules: Set<string>
}

/** One classic script: no import(), no import.meta, no top-level await. */
async function buildScript(entry: string): Promise<Bundle> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    build: {
      write: false,
      target: 'es2023',
      minify: true,
      sourcemap: false,
      lib: {
        entry: resolve(repository, entry),
        formats: ['iife'],
        name: 'devotMermaidFrame',
        fileName: () => 'frame.js',
      },
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

/** The frame's script and every engine's, by published name, the frame's first. */
export async function buildMermaidFrame(): Promise<Map<string, Bundle>> {
  const names = [...SCRIPTS.keys()]
  const bundles = await Promise.all(names.map((name) => buildScript(SCRIPTS.get(name)!)))
  return new Map(names.map((name, i) => [name, bundles[i]!]))
}

export function mermaidFrame(): Plugin {
  const cached = new Map<string, Promise<Bundle>>()
  const bundle = (name: string) => {
    let built = cached.get(name)
    if (!built) {
      built = buildScript(SCRIPTS.get(name)!)
      built.catch(() => cached.delete(name))
      cached.set(name, built)
    }
    return built
  }
  return {
    name: 'devot-mermaid-frame',
    configureServer(server) {
      // Built ahead, so the first diagram does not wait seconds for the bundles.
      const warm = (name: string) => void bundle(name).catch(() => undefined)
      SCRIPTS.forEach((_, name) => warm(name))
      server.watcher.on('change', (file) => {
        for (const [name, built] of cached) {
          built.then(
            ({ modules }) => {
              if (!modules.has(file) || cached.get(name) !== built) return
              cached.delete(name)
              warm(name)
            },
            () => undefined,
          )
        }
      })
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.slice(1) ?? ''
        if (!SCRIPTS.has(name)) return next()
        bundle(name).then(({ code }) => {
          res.setHeader('content-type', 'text/javascript')
          res.setHeader('cache-control', 'no-cache')
          res.end(code)
        }, next)
      })
    },
    async generateBundle() {
      const bundles = await buildMermaidFrame()
      for (const [fileName, { code }] of bundles) {
        this.emitFile({ type: 'asset', fileName, source: code })
      }
    },
  }
}
