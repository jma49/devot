import type { DiagramKind } from '../preview/mermaid-protocol'
import { registeredEngine, type DrawingEngine } from './registry'

/**
 * Loads each engine's script once, when a diagram first asks for it.
 * A script that fails, or registers nothing, fails that request and is asked for again with the next.
 */
export function engineLoader(
  scripts: Record<DiagramKind, string>,
  find: (kind: DiagramKind) => DrawingEngine | undefined = registeredEngine,
): (kind: DiagramKind) => Promise<DrawingEngine> {
  const loading = new Map<DiagramKind, Promise<DrawingEngine>>()
  return (kind) => {
    let loaded = loading.get(kind)
    if (!loaded) {
      // A classic script: a module script or import() would be a CORS request, which the app refuses.
      loaded = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = scripts[kind]
        script.onload = () => {
          const found = find(kind)
          if (found) resolve(found)
          else reject(new Error('E_DIAGRAM_ENGINE'))
        }
        script.onerror = () => {
          script.remove()
          reject(new Error('E_DIAGRAM_ENGINE'))
        }
        document.head.appendChild(script)
      })
      loaded.catch(() => loading.delete(kind))
      loading.set(kind, loaded)
    }
    return loaded
  }
}
