// The hidden frame that draws diagrams. Mermaid and its libraries assign to
// prototypes, which fails in the main window, where Object.prototype is
// frozen; subframes are not frozen. The frame talks to its parent only
// through the private port the parent hands over, and the parent rebuilds the
// returned SVG safely (preview/mermaid.ts). Each engine is a classic script
// of its own, loaded when the first diagram that needs it is drawn.
import { engineLoader } from './diagram-engines/loader'
import {
  isRenderRequest,
  READY,
  targetOrigin,
  type FrameMessage,
  type RenderRequest,
} from './preview/mermaid-protocol'

let port: MessagePort | undefined
/** Requests are drawn one after another (Mermaid's settings are global). */
let queue: Promise<void> = Promise.resolve()
/** Built and served by scripts/vite/mermaid-frame.ts. */
const engine = engineLoader({
  mermaid: '/mermaid-frame-mermaid.js',
  plantuml: '/mermaid-frame-plantuml.js',
  markmap: '/mermaid-frame-markmap.js',
})

const reply = (message: FrameMessage) => port?.postMessage(message)

// Through the CSSOM: a stylesheet would be a CORS request from this sandboxed frame.
document.body.style.margin = '0'
// Hidden frames may suspend animation frames; layout libraries still need their next turn.
window.requestAnimationFrame = (callback) =>
  window.setTimeout(() => callback(performance.now()), 16)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)

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
