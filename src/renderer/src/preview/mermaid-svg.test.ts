// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { importSvg } from './mermaid'

const drawing = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" id="d">${body}</svg>`

describe('a drawing taken from the frame', () => {
  it('keeps its styling but nothing that loads from elsewhere', () => {
    const { svg, css } = importSvg(
      drawing(
        '<style>#d .node{fill:#fff;background:url(https://tracker.example/id)}#d path{marker-end:url(#arrow)}</style>' +
          '<rect style="fill: red; background-image: url(https://tracker.example/rect)" />' +
          '<path marker-end="url(#arrow)" filter="url(https://tracker.example/f#x)" />',
      ),
    )
    expect(css).toBe(`#${svg.id} .node{fill:#fff;}#${svg.id} path{marker-end:url(#arrow)}`)
    const rect = svg.querySelector('rect') as SVGElement
    expect(rect.getAttribute('style') ?? '').not.toContain('tracker')
    expect(rect.style.getPropertyValue('fill')).toBe('red')
    const path = svg.querySelector('path')!
    expect(path.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(path.hasAttribute('filter')).toBe(false)
  })

  it('drops animations that could point a link elsewhere later, and filter images', () => {
    const { svg } = importSvg(
      drawing(
        '<a href="#n"><text>n</text>' +
          '<set attributeName="href" to="https://tracker.example/s" />' +
          '<animate attributeName="href" values="https://tracker.example/a" />' +
          '<animateMotion path="M0 0" /><animateTransform attributeName="transform" />' +
          '<discard begin="1s" /></a>' +
          '<filter id="f"><feImage href="https://tracker.example/i" /><feGaussianBlur stdDeviation="1" /></filter>',
      ),
    )
    for (const name of [
      'set',
      'animate',
      'animateMotion',
      'animateTransform',
      'discard',
      'feImage',
    ])
      expect(svg.getElementsByTagName(name)).toHaveLength(0)
    expect(svg.outerHTML).not.toContain('tracker')
    expect(svg.querySelector('a')?.getAttribute('href')).toBe('#n')
    expect(svg.getElementsByTagName('feGaussianBlur')).toHaveLength(1)
  })

  it('gives each import of the same markup ids of its own', () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg" id="devot-mermaid-7">' +
      '<style>#devot-mermaid-7 .node{fill:red}#devot-mermaid-7-pie-gaps{stroke:blue}#devot-mermaid-70 .x{fill:green}</style>' +
      '<defs><marker id="devot-mermaid-7-arrow"/><g id="devot-mermaid-7-sym"/>' +
      '<marker id="devot-mermaid-7_flowchart-v2-pointEnd"/></defs>' +
      '<path marker-end="url(#devot-mermaid-7-arrow)"/>' +
      '<textPath href="#devot-mermaid-7-sym"/><g id="devot-mermaid-70"/></svg>'
    const copies = [importSvg(markup), importSvg(markup)]
    const [one, two] = copies.map((c) => c.svg.getAttribute('id')!)
    expect(one).not.toBe(two)
    expect(one).not.toBe('devot-mermaid-7')
    const idsOf = (svg: Element) => Array.from(svg.querySelectorAll('[id]'), (el) => el.id)
    const shared = idsOf(copies[0]!.svg).filter((id) => idsOf(copies[1]!.svg).includes(id))
    expect(shared).toEqual(['devot-mermaid-70'])
    for (const { svg, css } of copies) {
      const own = svg.getAttribute('id')!
      const ids = new Set([own, ...Array.from(svg.querySelectorAll('[id]'), (el) => el.id)])
      const refs = [
        ...Array.from(svg.querySelectorAll('*'), (el) => [
          el.getAttribute('marker-end')?.match(/url\(#([^)]+)\)/)?.[1],
          el.getAttribute('href')?.slice(1),
        ]).flat(),
      ].filter((ref): ref is string => ref !== undefined)
      expect(refs).toHaveLength(2)
      for (const ref of refs) expect(ids.has(ref)).toBe(true)
      const selected = [...css.matchAll(/#(devot-mermaid-[\w-]+)/g)].map((m) => m[1]!)
      expect(selected.filter((id) => id.startsWith(own))).toHaveLength(2)
      expect(selected).toContain('devot-mermaid-70')
      for (const id of selected) expect(id === 'devot-mermaid-70' || id.startsWith(own)).toBe(true)
    }
  })
})
