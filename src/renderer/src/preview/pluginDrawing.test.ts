// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { importPluginSvg } from './pluginDrawing'

const drawing = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`

describe('a drawing a plugin answers', () => {
  it('keeps shapes, text and styling, and nothing that runs, links or loads from elsewhere', () => {
    const { svg, css } = importPluginSvg(
      drawing(
        '<style>.n{fill:#fff;background:url(https://tracker.example/id)}</style>' +
          '<g class="n" onclick="steal()"><rect width="4" style="fill: red" /><text>a &lt; b</text></g>' +
          '<script>steal()</script><foreignObject><div>x</div></foreignObject>' +
          '<a href="https://example.com"><circle r="1" /></a><use href="#g" /><image href="x.png" />' +
          '<animate attributeName="href" to="javascript:steal()" /><set attributeName="fill" to="red" />' +
          '<path marker-end="url(#arrow)" filter="url(https://tracker.example/f#x)" />',
      ),
    )
    expect(css).toBe('.n{fill:#fff;}')
    expect([...svg.querySelectorAll('*')].map((e) => e.localName)).toEqual([
      'g',
      'rect',
      'text',
      'path',
    ])
    expect(svg.querySelector('g')!.hasAttribute('onclick')).toBe(false)
    expect((svg.querySelector('rect') as SVGElement).style.getPropertyValue('fill')).toBe('red')
    expect(svg.querySelector('text')!.textContent).toBe('a < b')
    const path = svg.querySelector('path')!
    expect(path.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(path.hasAttribute('filter')).toBe(false)
  })

  it('refuses what is not SVG', () => {
    expect(() => importPluginSvg('<html><body>x</body></html>')).toThrow('E_PLUGIN_SVG')
    expect(() => importPluginSvg('<svg')).toThrow('E_PLUGIN_SVG')
  })
})
