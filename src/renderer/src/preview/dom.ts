// Applies a sanitized hast tree to the DOM, touching only nodes that changed,
// so embeds keep playing and the scroll position holds while the user types.
// Nodes are built with DOM APIs, never through HTML strings.
import type { Element as HastElement, ElementContent, RootContent } from 'hast'
import { find, html } from 'property-information'

type HastChild = RootContent | ElementContent

const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML'

/** MathML starts at `<math>`; everything inside it stays in that namespace. */
function namespaceFor(tagName: string, parentNs: string | null): string {
  if (tagName === 'math') return MATHML_NS
  return parentNs === MATHML_NS ? MATHML_NS : HTML_NS
}

function attributes(node: HastElement): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined || value === false) continue
    const info = find(html, key)
    // Inline styles are never set through attributes (the CSP forbids them).
    if (info.attribute === 'style') continue
    const text =
      value === true
        ? ''
        : Array.isArray(value)
          ? value.join(info.commaSeparated ? ', ' : ' ')
          : String(value)
    out.set(info.attribute, text)
  }
  // A frame's sandbox must be in place before it starts loading.
  const src = out.get('src')
  if (src !== undefined) {
    out.delete('src')
    out.set('src', src)
  }
  return out
}

/** Colour swatches get their colour through the CSSOM, after validation. */
function applySwatch(el: Element): void {
  const color = el.getAttribute('data-swatch-color')
  if (color && el instanceof HTMLElement && CSS.supports('color', color)) {
    el.style.backgroundColor = color
  }
}

function syncAttributes(el: Element, node: HastElement): void {
  const next = attributes(node)
  for (const name of el.getAttributeNames()) {
    if (name !== 'style' && !next.has(name)) el.removeAttribute(name)
  }
  for (const [name, value] of next) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  applySwatch(el)
}

/** Islands own their children (the UI renders them); the patcher skips them. */
const isIsland = (node: HastElement) => node.properties['dataDevotIsland'] !== undefined

function create(node: HastChild, parentNs: string | null): Node | null {
  if (node.type === 'text') return document.createTextNode(node.value)
  if (node.type !== 'element') return null
  const el = document.createElementNS(namespaceFor(node.tagName, parentNs), node.tagName)
  syncAttributes(el, node)
  if (!isIsland(node)) patchChildren(el, node.children)
  return el
}

function sameKind(dom: Node, node: HastChild, parentNs: string | null): boolean {
  if (node.type === 'text') return dom.nodeType === Node.TEXT_NODE
  return (
    node.type === 'element' &&
    dom instanceof Element &&
    dom.localName === node.tagName &&
    dom.namespaceURI === namespaceFor(node.tagName, parentNs) &&
    // A different embed is a new frame, not a navigation of the old one.
    (node.tagName !== 'iframe' || dom.getAttribute('src') === node.properties['src'])
  )
}

/**
 * The page's own controls in the preview (a code block's copy button) carry
 * this attribute. They are not part of the note's HTML: the patcher never
 * reuses, replaces or removes them, and they always follow the note's nodes.
 */
export const UI_ATTRIBUTE = 'data-devot-ui'

const isUi = (node: Node) => node instanceof Element && node.hasAttribute(UI_ATTRIBUTE)

/** Makes `parent`'s children match `next`, reusing nodes position by position. */
export function patchChildren(parent: Node, next: readonly HastChild[]): void {
  const wanted = next.filter((n) => n.type === 'text' || n.type === 'element')
  const ns = parent instanceof Element ? parent.namespaceURI : HTML_NS
  // Controls sit last, so most parents (those without) take the quick path.
  const withUi = parent.lastChild !== null && isUi(parent.lastChild)
  const own: ArrayLike<ChildNode> = withUi
    ? Array.from(parent.childNodes).filter((n) => !isUi(n))
    : parent.childNodes
  // New nodes go before the page's controls.
  const end = withUi ? (Array.from(parent.childNodes).find(isUi) ?? null) : null
  for (let i = 0; i < wanted.length; i += 1) {
    const node = wanted[i]!
    const dom = own[i]
    if (!dom) {
      const created = create(node, ns)
      if (created) parent.insertBefore(created, end)
    } else if (!sameKind(dom, node, ns)) {
      const created = create(node, ns)
      if (created) parent.replaceChild(created, dom)
    } else if (node.type === 'text') {
      if (dom.nodeValue !== node.value) dom.nodeValue = node.value
    } else if (node.type === 'element') {
      syncAttributes(dom as Element, node)
      if (!isIsland(node)) patchChildren(dom, node.children)
    }
  }
  if (withUi) for (const extra of Array.from(own).slice(wanted.length)) extra.remove()
  else while (parent.childNodes.length > wanted.length) parent.lastChild?.remove()
}
