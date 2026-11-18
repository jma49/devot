// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { KeptDrawing } from '../../../core/plugins/drawings'
import { keptDrawingsChanged, loadKeptDrawings } from './keptDrawings'
import { importPluginSvg, keptDrawingIsland, keptMarkup } from './pluginDrawing'

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

describe('a drawing kept with the note (ADR 0030)', () => {
  const NOTE = '0192a6f0-0000-7000-8000-000000000001'
  const HASH = 'a'.repeat(64)
  const keptOf = (svg: string, over: Partial<KeptDrawing> = {}): KeptDrawing => ({
    pluginId: 'com.example.graphviz',
    language: 'dot',
    hash: HASH,
    appearance: 'light',
    svg,
    ...over,
  })
  const holding = async (drawings: KeptDrawing[]) => {
    keptDrawingsChanged()
    await loadKeptDrawings(async () => drawings, NOTE)
  }
  const shown = (source = `dot\n${HASH}\na -> b`, appearance: 'light' | 'dark' = 'light') =>
    keptDrawingIsland.render(source, { appearance, noteId: NOTE })

  it('is rebuilt through the allowlist into a shadow root, with no Edit button', async () => {
    await holding([
      keptOf(
        drawing(
          '<style>:host{position:fixed;inset:0} .n{fill:#fff;background:url(https://tracker.example/id)}</style>' +
            '<g class="n" onload="steal()"><rect width="4" /></g><script>steal()</script>' +
            '<foreignObject><iframe src="https://example.com"></iframe></foreignObject>' +
            '<image href="https://tracker.example/i.png" /><use href="https://example.com/x.svg#y" />' +
            '<path filter="url(https://tracker.example/f#x)" /><rect x="-99999" width="999999" height="999999" />',
        ),
      ),
    ])
    const { node } = await shown()
    const host = node as HTMLElement
    expect(host.className).toBe('plugin-drawing')
    expect(host.querySelector('svg')).toBeNull()
    const svg = host.shadowRoot!.querySelector('svg')!
    expect([...svg.querySelectorAll('*')].map((e) => e.localName)).toEqual([
      'g',
      'rect',
      'path',
      'rect',
    ])
    expect(svg.querySelector('g')!.hasAttribute('onload')).toBe(false)
    expect(svg.querySelector('path')!.hasAttribute('filter')).toBe(false)
    const rules = host.shadowRoot!.adoptedStyleSheets.flatMap((sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText),
    )
    expect(rules.join('\n')).not.toMatch(/:host|https:/)
    expect(host.querySelector('button')).toBeNull()
  })

  it('shows the block as code with a note for markup that is not SVG', async () => {
    await holding([keptOf('<html><body><script>steal()</script></body></html>')])
    const { node } = await shown()
    expect((node as HTMLElement).className).toBe('kept-drawing-code')
    expect(node.textContent).toContain('a -> b')
    expect((node as HTMLElement).querySelector('script')).toBeNull()
    expect((node as HTMLElement).querySelector('.kept-drawing-note')).not.toBeNull()
  })

  it('shows code for a block whose content or appearance has no drawing', async () => {
    await holding([keptOf(drawing('<rect width="1" />'))])
    for (const source of [`dot\n${'b'.repeat(64)}\na -> c`, `d2\n${HASH}\na -> b`]) {
      expect(((await shown(source)).node as HTMLElement).className).toBe('kept-drawing-code')
    }
    expect(((await shown(undefined, 'dark')).node as HTMLElement).className).toBe(
      'kept-drawing-code',
    )
    expect(
      (
        (await keptDrawingIsland.render(`dot\n${HASH}\na`, { appearance: 'light' }))
          .node as HTMLElement
      ).className,
    ).toBe('kept-drawing-code')
  })

  it('keeps a rebuilt drawing as markup that rebuilds the same', () => {
    const { svg, css } = importPluginSvg(
      drawing('<style>.n{fill:#fff}</style><g class="n"><text>a &lt; b</text></g>'),
    )
    const again = importPluginSvg(keptMarkup(svg, css))
    expect(again.css).toBe(css)
    expect(again.svg.querySelector('text')!.textContent).toBe('a < b')
  })
})
