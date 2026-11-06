// The hidden frame that draws Mermaid diagrams. Mermaid and its libraries
// assign to prototypes, which fails in the main window, where Object.prototype
// is frozen; subframes are not frozen. The frame talks to its parent only
// through the private port the parent hands over, and the parent rebuilds the
// returned SVG safely (preview/mermaid.ts).
import mermaid from 'mermaid'
import { markmapDrawing, plantumlDrawing } from './diagram-frame'
import {
  isRenderRequest,
  READY,
  targetOrigin,
  type FrameMessage,
  type RenderRequest,
} from './preview/mermaid-protocol'
import { finishDrawing, frameSettings } from './preview/mermaid-theme'

let port: MessagePort | undefined
/** Requests are drawn one after another (Mermaid's settings are global). */
let queue: Promise<void> = Promise.resolve()

const reply = (message: FrameMessage) => port?.postMessage(message)

// Through the CSSOM: a stylesheet would be a CORS request from this sandboxed frame.
document.body.style.margin = '0'
// Hidden frames may suspend animation frames; layout libraries still need their next turn.
window.requestAnimationFrame = (callback) =>
  window.setTimeout(() => callback(performance.now()), 16)
window.cancelAnimationFrame = (id) => window.clearTimeout(id)

async function draw(request: RenderRequest): Promise<void> {
  if (request.kind === 'plantuml' || request.kind === 'markmap') {
    try {
      const svg = await (request.kind === 'plantuml' ? plantumlDrawing : markmapDrawing)(request)
      reply({ type: 'rendered', id: request.id, svg })
    } catch {
      reply({ type: 'failed', id: request.id, reason: 'parse' })
    }
    return
  }

  // Mermaid measures text in this document: give it the diagram's font.
  document.body.style.fontFamily = request.fontFamily
  document.body.style.fontSize = request.fontSize
  mermaid.initialize(frameSettings(request))
  // A container of its own, removed when this drawing is done; nothing else
  // in the document is touched.
  const container = document.createElement('div')
  document.body.appendChild(container)
  try {
    const { svg } = await mermaid.render(`devot-mermaid-${request.id}`, request.source, container)
    reply({ type: 'rendered', id: request.id, svg: finishDrawing(svg) })
  } catch {
    // Only a drawing that failed is checked for an error in its source, so a
    // diagram that draws is parsed once. A source that parses but cannot be
    // laid out fails the same way every time: it is not asked again. A
    // failure before Mermaid runs (above) may pass, and is asked for again.
    const parsed = await mermaid.parse(request.source, { suppressErrors: true }).catch(() => false)
    reply({ type: 'failed', id: request.id, reason: parsed ? 'layout' : 'parse' })
  } finally {
    container.remove()
  }
}

function render(request: RenderRequest): void {
  queue = queue
    .then(() => draw(request))
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
