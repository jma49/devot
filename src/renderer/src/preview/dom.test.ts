// @vitest-environment happy-dom
import type { ElementContent, Element as HastElement } from 'hast'
import { describe, expect, it } from 'vitest'
import { createPieceRenderer, type PreviewOptions } from '../../../core'
import { sampleNote } from '../../../../scripts/bench/fixtures'
import { labels } from '../../../../tests/support/preview-html'
import { buildPending, patchChildren, patchPieces, type NextPiece, type ShownPiece } from './dom'

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

    expect(Array.from(host.children, (child) => child.textContent)).toEqual([
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
    expect(Array.from(host.children, (child) => child.textContent)).toEqual(['A', 'B1', 'B2', 'C'])
    shown = patchPieces(host, shown, [known('a', 1), known('c', 2), known('e', 3)])
    expect(Array.from(host.children, (child) => child.textContent)).toEqual(['A', 'C'])
    expect(shown.map((p) => p.key)).toEqual(['a', 'c', 'e'])
  })

  it('moves each part of a piece from its own start', () => {
    const host = document.createElement('div')
    const task = (at: number): HastElement => ({
      type: 'element',
      tagName: 'input',
      properties: { type: 'checkbox', dataTaskAt: at },
      children: [],
    })
    const list: HastElement = {
      type: 'element',
      tagName: 'ol',
      properties: {},
      children: [
        { ...paragraph('One', 1), children: [task(4)] },
        { ...paragraph('Two', 2), children: [task(5)] },
      ],
    }
    const parts = (one: number, two: number) => [
      { line: one, offset: one * 10, marks: 2 },
      { line: two, offset: two * 10, marks: 2 },
    ]
    let shown = patchPieces(
      host,
      [],
      [{ key: 'notes', line: 3, offset: 30, parts: parts(3, 8), nodes: [list] }],
    )
    const read = () =>
      Array.from(
        host.querySelectorAll('p, input'),
        (found) => found.getAttribute('data-source-line') ?? found.getAttribute('data-task-at'),
      )
    expect(read()).toEqual(['3', '34', '9', '85'])
    shown = patchPieces(host, shown, [{ key: 'notes', line: 3, offset: 30, parts: parts(3, 10) }])
    expect(read()).toEqual(['3', '34', '11', '105'])
    expect(shown[0]!.parts).toEqual(parts(3, 10))
  })
})

const options: PreviewOptions = { labels, loadedEmbeds: [] }

/** The benchmark sample with footnotes (a piece in parts), tasks and images (offsets). */
const richNote = (bytes: number, tag = '') =>
  sampleNote(bytes, tag).replace(/Paragraph (\d+)(\S*) goes on/g, 'Paragraph $1$2[^n$1] goes on') +
  '\n\n' +
  Array.from({ length: 40 }, (_, i) => `[^n${i + 1}]: Footnote ${i + 1}.`).join('\n\n')

/** `next` as patching every piece over another note's preview builds it: the reference. */
function patchedOver(next: readonly NextPiece[], over: readonly NextPiece[]): Element {
  const host = document.createElement('div')
  patchPieces(host, patchPieces(host, [], over), next)
  return host
}

describe('patchPieces, deferring', () => {
  it('builds a piece anew with the attributes patching gives it', async () => {
    const next = await createPieceRenderer()(richNote(40_000), options)
    const other = await createPieceRenderer()(richNote(40_000, 'x'), options)
    const host = document.createElement('div')
    patchPieces(host, [], next)
    expect(host.querySelector('[data-task-at]')).not.toBeNull()
    expect(host.querySelector('[data-image-from]')).not.toBeNull()
    expect(host.innerHTML).toBe(patchedOver(next, other).innerHTML)
  })

  it('leaves the pieces past those on screen to be built later', async () => {
    const next = await createPieceRenderer()(richNote(40_000), options)
    const host = document.createElement('div')
    const shown = patchPieces(host, [], next, { defer: true })
    expect(host.childNodes).toHaveLength(0)
    expect(shown.every((one) => one.nodes.length === 0)).toBe(true)
    expect(buildPending(host, shown, () => true)).toBe(next.length)
    expect(host.innerHTML).toBe(patchedOver(next, []).innerHTML)
  })

  it('takes an edit before and after the built pieces as a whole build would', async () => {
    const render = createPieceRenderer()
    const note = richNote(60_000)
    const host = document.createElement('div')
    let shown = patchPieces(host, [], await render(note, options), { defer: true })
    let built = 0
    buildPending(host, shown, () => (built += 1) <= 4)
    const early = note.indexOf('goes on for a while')
    const late = note.indexOf('goes on for a while', note.length / 2)
    const edited = `${note.slice(0, early)}more ${note.slice(early, late)}\n\nNew paragraph.\n\n${note.slice(late)}`
    const next = await render(
      edited,
      options,
      shown.map((one) => one.key),
    )
    shown = patchPieces(host, shown, next, { defer: true })
    buildPending(host, shown, () => true)
    expect(shown.every((one) => one.pending === undefined)).toBe(true)
    expect(host.innerHTML).toBe(
      patchedOver(await createPieceRenderer()(edited, options), []).innerHTML,
    )
  })

  it('builds the waiting pieces before a kept piece moves', () => {
    const host = document.createElement('div')
    const shown = patchPieces(
      host,
      [],
      [piece('a', 'A', 1), piece('b', 'B', 2), piece('c', 'C', 3)],
      {
        defer: true,
      },
    )
    buildPending(host, shown, (next) => next.key === 'a')
    patchPieces(host, shown, [known('c', 1), known('a', 2), known('b', 3)], { defer: true })
    expect(Array.from(host.children, (child) => child.textContent)).toEqual(['C', 'A', 'B'])
  })
})
