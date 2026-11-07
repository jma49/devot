// @vitest-environment happy-dom
import type { ElementContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { patchChildren } from './dom'

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
