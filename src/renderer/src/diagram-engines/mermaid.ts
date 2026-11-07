import mermaid from 'mermaid'
import type { RenderRequest } from '../preview/mermaid-protocol'
import { finishDrawing, frameSettings } from '../preview/mermaid-theme'
import { registerEngine, type Drawing } from './registry'

async function draw(request: RenderRequest): Promise<Drawing> {
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
    return { type: 'rendered', svg: finishDrawing(svg) }
  } catch {
    // Only a drawing that failed is checked for an error in its source, so a
    // diagram that draws is parsed once. A source that parses but cannot be
    // laid out fails the same way every time: it is not asked again. A
    // failure before Mermaid runs (above) may pass, and is asked for again.
    const parsed = await mermaid.parse(request.source, { suppressErrors: true }).catch(() => false)
    return { type: 'failed', reason: parsed ? 'layout' : 'parse' }
  } finally {
    container.remove()
  }
}

registerEngine('mermaid', draw)
