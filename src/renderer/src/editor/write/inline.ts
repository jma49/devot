// Write mode's inline elements the preview draws (an emoji shortcode, `<kbd>`,
// `<sup>`, `<sub>`): the element's Markdown goes through the preview's own
// renderers in the core, and the sanitised tree is built with DOM APIs
// (preview/dom.ts), as for the rendered blocks. Until the renderer answers the
// first time, the widget shows the source; later draws come from the cache.
import { EditorView, WidgetType } from '@codemirror/view'
import type { ElementContent, RootContent } from 'hast'
import { patchChildren } from '../../preview/dom'
import { Recent, writeRenderer } from './rendered'

type Inline = readonly ElementContent[] | null

const drawnInline = new Recent<Inline>(500)
const asked = new Map<string, Promise<Inline>>()

/** A paragraph's content: an inline element renders as one paragraph, anything else is no inline. */
export function paragraphContent(nodes: readonly RootContent[]): Inline {
  const only = nodes.length === 1 ? nodes[0] : undefined
  return only?.type === 'element' && only.tagName === 'p' ? only.children : null
}

function render(view: EditorView, source: string): Promise<Inline> | null {
  const waiting = asked.get(source)
  if (waiting) return waiting
  const renderer = view.state.facet(writeRenderer)
  if (!renderer) return null
  const answer = renderer.render(source, []).then(paragraphContent)
  asked.set(source, answer)
  const settle = () => asked.delete(source)
  answer.then(settle, settle)
  return answer
}

export class InlineWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  override eq(other: InlineWidget): boolean {
    return other.source === this.source
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-wm-inline'
    const place = (nodes: Inline) => {
      if (nodes) patchChildren(box, nodes)
      else box.textContent = this.source
    }
    const known = drawnInline.get(this.source)
    if (known !== undefined) {
      place(known)
      return box
    }
    place(null)
    render(view, this.source)?.then(
      (nodes) => {
        drawnInline.set(this.source, nodes)
        place(nodes)
        view.requestMeasure()
      },
      () => console.warn('W_WRITE_INLINE_RENDER_FAILED'),
    )
    return box
  }

  /** A click puts the caret there, as on text. */
  override ignoreEvent(): boolean {
    return false
  }
}
