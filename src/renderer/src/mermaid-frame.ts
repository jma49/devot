// The hidden frame that draws diagrams. Mermaid and its libraries assign to
// prototypes, which fails in the main window, where Object.prototype is
// frozen; subframes are not frozen. The frame talks to its parent only
// through the private port the parent hands over, and the parent rebuilds the
// returned SVG safely (preview/mermaid.ts). Each engine is a classic script
// of its own, loaded when the first diagram that needs it is drawn.
import { registeredEngine, type DrawingEngine } from './diagram-engines/registry'
import {
  isRenderRequest,
  READY,
  targetOrigin,
  type DiagramKind,
  type FrameMessage,
  type RenderRequest,
} from './preview/mermaid-protocol'

let port: MessagePort | undefined
/** Requests are drawn one after another (Mermaid's settings are global). */
let queue: Promise<void> = Promise.resolve()
const loading = new Map<DiagramKind, Promise<DrawingEngine>>()
/** Built and served by scripts/vite/mermaid-frame.ts. */
const ENGINE_SCRIPTS: Record<DiagramKind, string> = {
  mermaid: '/mermaid-frame-mermaid.js',
  plantuml: '/mermaid-frame-plantuml.js',
  markmap: '/mermaid-frame-markmap.js',
}

const reply = (message: FrameMessage) => port?.postMessage(message)

// Through the CSSOM: a stylesheet would be a CORS request from this sandboxed frame.
document.body.style.margin = '0'
// Hidden frames may suspend animation frames; layout libraries still need their next turn.
window.requestAnimationFrame = (callback) =>
  window.setTimeout(() => callback(performance.now()), 16)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)

/** A classic script: a module script or import() would be a CORS request, which the app refuses. */
function engine(kind: DiagramKind): Promise<DrawingEngine> {
  let loaded = loading.get(kind)
  if (!loaded) {
    loaded = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = ENGINE_SCRIPTS[kind]
      script.onload = () => {
        const found = registeredEngine(kind)
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

function render(request: RenderRequest): void {
  queue = queue
    .then(() => engine(request.kind ?? 'mermaid'))
    .then((draw) => draw(request))
    .then((drawing) => reply({ ...drawing, id: request.id }))
    .catch(() => reply({ type: 'failed', id: request.id, reason: 'render' }))
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || window.parent === window) return
  if (event.origin !== location.origin && location.origin !== 'null') return
  const [received] = event.ports
  if (event.data !== READY || !received) return
  port?.close()
  port = received
  port.onmessage = (message) => {
    if (isRenderRequest(message.data)) render(message.data)
  }
})

if (window.parent !== window) window.parent.postMessage(READY, targetOrigin())
