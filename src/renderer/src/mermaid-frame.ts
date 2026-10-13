// The hidden frame that draws Mermaid diagrams. Mermaid and its libraries
// assign to prototypes, which fails in the main window, where Object.prototype
// is frozen; subframes are not frozen. The frame talks to its parent only
// through the private port the parent hands over, and the parent rebuilds the
// returned SVG safely (preview/mermaid.ts).
import mermaid from 'mermaid'
import {
  isRenderRequest,
  READY,
  targetOrigin,
  type FrameMessage,
  type RenderRequest,
} from './preview/mermaid-protocol'
import './mermaid-frame.css'

let port: MessagePort | undefined
/** Requests are drawn one after another (Mermaid's settings are global). */
let queue: Promise<void> = Promise.resolve()

const reply = (message: FrameMessage) => port?.postMessage(message)

async function draw(request: RenderRequest): Promise<void> {
  // Mermaid measures text in this document: give it the preview's font.
  document.body.style.fontFamily = request.fontFamily
  document.body.style.fontSize = request.fontSize
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: request.appearance === 'dark' ? 'dark' : 'neutral',
    fontFamily: request.fontFamily,
    themeVariables: { fontFamily: request.fontFamily, fontSize: request.fontSize },
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  })
  // A container of its own, removed when this drawing is done; nothing else
  // in the document is touched.
  const container = document.createElement('div')
  try {
    document.body.appendChild(container)
    const { svg } = await mermaid.render(`devot-mermaid-${request.id}`, request.source, container)
    reply({ type: 'rendered', id: request.id, svg })
  } catch {
    // Only a drawing that failed is checked for an error in its source, so a
    // diagram that draws is parsed once.
    const parsed = await mermaid.parse(request.source, { suppressErrors: true }).catch(() => false)
    reply({ type: 'failed', id: request.id, reason: parsed ? 'render' : 'parse' })
  } finally {
    container.remove()
  }
}

function render(request: RenderRequest): void {
  queue = queue
    .then(() => draw(request))
    .catch(() => reply({ type: 'failed', id: request.id, reason: 'render' }))
}

// The parent hands over a private port in answer to READY.
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
