import { Transformer } from 'markmap-lib'
import { Markmap } from 'markmap-view'
import type { RenderRequest } from '../preview/mermaid-protocol'
import { registerEngine } from './registry'

const SVG_NS = 'http://www.w3.org/2000/svg'

async function drawing(request: RenderRequest): Promise<string> {
  const transformer = new Transformer([])
  transformer.md.set({ html: false })
  const { root } = transformer.transform(request.source)
  const plain = (node: typeof root) => {
    const template = document.createElement('template')
    template.innerHTML = node.content
    const text = template.content.textContent ?? ''
    const escaped = document.createElement('span')
    escaped.textContent = text
    node.content = escaped.innerHTML
    delete node.payload
    node.children.forEach(plain)
  }
  plain(root)
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.fontFamily = request.fontFamily
  svg.style.fontSize = request.fontSize
  document.body.appendChild(svg)
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(
    '.markmap-foreign{display:inline-block}.markmap-foreign>div{width:9999px;text-align:left}.markmap-foreign>div>div{display:inline-block}',
  )
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  const colors = [request.palette.series1, request.palette.series2, request.palette.series3]
  const map = Markmap.create(svg, {
    duration: 0,
    embedGlobalCSS: false,
    zoom: false,
    pan: false,
    autoFit: false,
    maxWidth: 0,
    color: (node) => colors[node.state.depth % colors.length]!,
    style: () => '',
  })
  // Apply layout attributes immediately: the static SVG must not capture a D3 transition.
  map.transition = ((selection: unknown) => selection) as typeof map.transition
  try {
    await map.setData(root)
    await map.renderData()
    // Markmap labels are HTML; publish only SVG text, as for other diagram engines.
    for (const label of svg.querySelectorAll('foreignObject')) {
      const text = document.createElementNS(SVG_NS, 'text')
      text.textContent = label.textContent
      text.setAttribute('x', label.getAttribute('x') ?? '0')
      text.setAttribute('y', String(parseFloat(request.fontSize)))
      text.setAttribute('fill', request.palette.text)
      label.replaceWith(text)
    }
    svg.querySelectorAll('style').forEach((style) => style.remove())
    svg.querySelectorAll('path').forEach((path) => path.setAttribute('fill', 'none'))
    svg
      .querySelectorAll('circle')
      .forEach((circle) => circle.setAttribute('fill', request.palette.ground))
    const { x1, y1, x2, y2 } = map.state.rect
    const width = Math.max(1, x2 - x1 + 32)
    const height = Math.max(1, y2 - y1 + 32)
    svg.setAttribute('viewBox', `${x1 - 16} ${y1 - 16} ${width} ${height}`)
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(height))
    svg.removeAttribute('style')
    svg.setAttribute('font-family', request.fontFamily)
    svg.setAttribute('font-size', request.fontSize)
    const output = svg.cloneNode(true) as SVGSVGElement
    output.removeAttribute('style')
    return new XMLSerializer().serializeToString(output)
  } finally {
    map.destroy()
    svg.remove()
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((current) => current !== sheet)
  }
}

registerEngine('markmap', (request) =>
  drawing(request).then(
    (svg) => ({ type: 'rendered', svg }),
    () => ({ type: 'failed', reason: 'parse' }),
  ),
)
