// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeptDrawing } from '../../../core/plugins/drawings'
import { keptDrawingsChanged, loadKeptDrawings } from './keptDrawings'
import {
  importPluginSvg,
  keptDrawingIsland,
  keptMarkup,
  pluginIsland,
  setPluginDrawer,
} from './pluginDrawing'

const drawing = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`

describe('editable drawing redraws', () => {
  const context = { appearance: 'light' as const }
  const edits = { editable: new Set(['pad']), edit: async () => {} }
  const draw = (revision: string) =>
    setPluginDrawer(async () => drawing(`<text>${revision}</text>`), revision, edits)

  afterEach(() => {
    setPluginDrawer(undefined, '')
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('updates the drawing without replacing a focused Edit button', async () => {
    draw('first')
    const first = await pluginIsland.render('pad\nhi', context)
    const root = first.node as HTMLElement
    document.body.append(root)
    const button = root.querySelector('button')!
    const label = button.firstChild
    button.focus()
    draw('next')
    const next = await pluginIsland.render('pad\nhi', context)
    expect(next.update?.(root)).toBe(true)
    expect(root.querySelector('button')).toBe(button)
    expect(button.firstChild).toBe(label)
    expect(document.activeElement).toBe(button)
    expect(root.firstElementChild!.shadowRoot!.querySelector('text')!.textContent).toBe('next')
  })

  it('does not reuse controls for changed content or a different kind of root', async () => {
    draw('changed')
    const first = await pluginIsland.render('pad\nhi', context)
    const next = await pluginIsland.render('pad\nbye', context)
    expect(next.update?.(first.node)).toBe(false)
    expect(next.update?.(document.createElement('div'))).toBe(false)
  })

  it.each(['empty', 'missing button', 'extra child', 'wrong host', 'wrong button'])(
    'declines an in-place update with an unexpected child shape: %s',
    async (shape) => {
      draw('initial')
      const first = await pluginIsland.render('pad\nhi', context)
      const root = first.node as HTMLElement
      if (shape === 'empty') root.replaceChildren()
      if (shape === 'missing button') root.lastChild?.remove()
      if (shape === 'extra child') root.append(document.createElement('span'))
      if (shape === 'wrong host') root.firstChild?.replaceWith(document.createElement('div'))
      if (shape === 'wrong button') root.lastChild?.replaceWith(document.createElement('div'))
      const before = [...root.childNodes]
      draw('next')
      const next = await pluginIsland.render('pad\nhi', context)
      expect(next.update?.(root)).toBe(false)
      expect([...root.childNodes]).toEqual(before)
    },
  )

  it.each(['declined', 'failed'])('replaces controls when a drawing is %s', async (answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    draw('initial')
    await pluginIsland.render('pad\nhi', context)
    setPluginDrawer(
      async () => {
        if (answer === 'failed') throw new Error('E_PLUGIN_STOPPED')
        return null
      },
      answer,
      edits,
    )
    const next = await pluginIsland.render('pad\nhi', context)
    expect(next.update).toBeUndefined()
    expect((next.node as Element).querySelector('button')).toBeNull()
  })
})

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

  it('keeps the size of a blur and a morphology within bounds', () => {
    const { svg } = importPluginSvg(
      drawing(
        '<filter id="f"><feGaussianBlur stdDeviation="2 9000" /><feMorphology radius="1e9" />' +
          '<feGaussianBlur stdDeviation="lots" /><feMorphology radius="-3" /></filter>',
      ),
    )
    const [blur, morph, badBlur, negative] = [...svg.querySelectorAll('filter > *')]
    expect(blur!.getAttribute('stdDeviation')).toBe('2 32')
    expect(morph!.getAttribute('radius')).toBe('16')
    expect(badBlur!.hasAttribute('stdDeviation')).toBe(false)
    expect(negative!.getAttribute('radius')).toBe('0')
  })

  it('keeps the size of a drop shadow within bounds', () => {
    const { svg } = importPluginSvg(
      drawing('<filter id="f"><feDropShadow dx="2" stdDeviation="9000 3" /></filter>'),
    )
    const shadow = svg.querySelector('feDropShadow')!
    expect(shadow.getAttribute('stdDeviation')).toBe('32 3')
    expect(shadow.getAttribute('dx')).toBe('2')
  })

  it('drops CSS filters, which no bound holds, and keeps the rest of the styling', () => {
    const { svg, css } = importPluginSvg(
      drawing(
        '<style>.n{fill:#fff;filter:blur(9000px)}.m{-webkit-backdrop-filter:blur(9000px)}' +
          '.o{fil\\74 er:blur(9000px);stroke:red}.p{filter/**/:blur(9000px)}</style>' +
          '<rect style="fill: red; filter: blur(9000px); backdrop-filter: blur(9000px)" />' +
          '<g filter="blur(9000px)" /><path filter="url(#f)" />',
      ),
    )
    expect(css).toBe('.n{fill:#fff;}.m{}.o{stroke:red}.p{}')
    const rect = svg.querySelector('rect') as SVGElement
    expect(rect.style.getPropertyValue('fill')).toBe('red')
    expect(rect.style.getPropertyValue('filter')).toBe('')
    expect(rect.style.getPropertyValue('backdrop-filter')).toBe('')
    expect(svg.querySelector('g')!.hasAttribute('filter')).toBe(false)
    expect(svg.querySelector('path')!.getAttribute('filter')).toBe('url(#f)')
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
