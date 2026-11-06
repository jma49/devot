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
    expect(css).toBe('#d .node{fill:#fff;}#d path{marker-end:url(#arrow)}')
    const rect = svg.querySelector('rect') as SVGElement
    expect(rect.getAttribute('style') ?? '').not.toContain('tracker')
    expect(rect.style.getPropertyValue('fill')).toBe('red')
    const path = svg.querySelector('path')!
    expect(path.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(path.hasAttribute('filter')).toBe(false)
  })
})
