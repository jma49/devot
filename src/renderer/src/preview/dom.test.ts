// @vitest-environment happy-dom
import type { ElementContent, Element as HastElement } from 'hast'
import { describe, expect, it } from 'vitest'
import { patchChildren, patchPieces, type NextPiece, type ShownPiece } from './dom'

const el = (
  tagName: string,
  properties: Record<string, unknown>,
  children: ElementContent[] = [],
): ElementContent => ({ type: 'element', tagName, properties, children }) as ElementContent

const SVG_NS = 'http://www.w3.org/2000/svg'

const mark = (drawn: boolean) =>
  el('svg', { className: ['code-lang-icon'], viewBox: '0 0 24 24', ariaHidden: 'true' }, [
    ...(drawn
      ? [
          el('symbol', { id: 'devot-code-mark-js', viewBox: '0 0 24 24' }, [
            el('path', { d: 'M0 0' }),
          ]),
        ]
      : []),
    el('use', { href: '#devot-code-mark-js' }),
  ])

describe('patchChildren', () => {
  it('builds a code mark and the block that uses it as SVG, with their attribute names', () => {
    const host = document.createElement('div')
    const tree = [
      el('p', { dataSourceLine: 3, className: ['a', 'b'], ariaLabel: 'x' }),
      mark(true),
      mark(false),
    ]
    for (let i = 0; i < 2; i++) patchChildren(host, tree)
    const [p, first, second] = [...host.children]
    expect(p!.getAttribute('data-source-line')).toBe('3')
    expect(p!.getAttribute('class')).toBe('a b')
    expect(p!.getAttribute('aria-label')).toBe('x')
    for (const svg of [first!, second!]) {
      expect(svg.namespaceURI).toBe(SVG_NS)
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
      const use = svg.querySelector('use')!
      expect(use.namespaceURI).toBe(SVG_NS)
      expect(use.getAttribute('href')).toBe('#devot-code-mark-js')
    }
    expect(first!.querySelector('symbol')?.namespaceURI).toBe(SVG_NS)
    expect(host.querySelectorAll('symbol')).toHaveLength(1)
  })
})

const paragraph = (text: string, line = 1): HastElement => ({
  type: 'element',
  tagName: 'p',
  properties: { dataSourceLine: line },
  children: [{ type: 'text', value: text }],
})

const piece = (key: string, text: string, line: number): NextPiece => ({
  key,
  line,
  offset: line * 10,
  nodes: [paragraph(text)],
})

const known = (key: string, line: number): NextPiece => ({ key, line, offset: line * 10 })

/** The nodes added to or removed from `host` from now until the returned function is called. */
function watched(host: Element): () => Node[] {
  const observer = new MutationObserver(() => undefined)
  observer.observe(host, { childList: true })
  return () => {
    const records = observer.takeRecords()
    observer.disconnect()
    return records.flatMap((record) => [...record.removedNodes, ...record.addedNodes])
  }
}

describe('patchPieces', () => {
  it('leaves the pieces between two changed ones where they are', () => {
    const host = document.createElement('div')
    let shown: ShownPiece[] = patchPieces(
      host,
      [],
      [
        piece('a', 'A', 1),
        piece('b', 'B', 2),
        piece('c', 'C', 3),
        piece('d', 'D', 4),
        piece('notes', 'Notes', 2),
      ],
    )
    const [b, c, d] = [1, 2, 3].map((i) => host.children[i]!)
    const moved = watched(host)

    shown = patchPieces(host, shown, [
      known('a', 1),
      piece('b2', 'B edited', 2),
      known('c', 4),
      known('d', 5),
      piece('notes2', 'Notes edited', 2),
    ])

    expect(Array.from(host.children, (el) => el.textContent)).toEqual([
      'A',
      'B edited',
      'C',
      'D',
      'Notes edited',
    ])
    expect(host.children[1]).toBe(b)
    expect(host.children[2]).toBe(c)
    expect(host.children[3]).toBe(d)
    expect(moved()).toEqual([])
    expect(host.children[2]!.getAttribute('data-source-line')).toBe('4')
    expect(shown.map((p) => p.key)).toEqual(['a', 'b2', 'c', 'd', 'notes2'])
  })

  it('patches a run that grows or shrinks before a kept piece in place', () => {
    const host = document.createElement('div')
    let shown = patchPieces(host, [], [piece('a', 'A', 1), piece('b', 'B', 2), piece('c', 'C', 3)])
    shown = patchPieces(host, shown, [
      known('a', 1),
      { key: 'b2', line: 2, offset: 20, nodes: [paragraph('B1'), paragraph('B2', 2)] },
      known('c', 4),
      { key: 'e', line: 5, offset: 50, nodes: [] },
    ])
    expect(Array.from(host.children, (el) => el.textContent)).toEqual(['A', 'B1', 'B2', 'C'])
    shown = patchPieces(host, shown, [known('a', 1), known('c', 2), known('e', 3)])
    expect(Array.from(host.children, (el) => el.textContent)).toEqual(['A', 'C'])
    expect(shown.map((p) => p.key)).toEqual(['a', 'c', 'e'])
  })
})
