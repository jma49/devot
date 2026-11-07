// @vitest-environment happy-dom
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewFindTarget, previewTextReader, WATCHED } from './find'

const PIECES = [
  '<p>A cat and <em>a dog</em>.</p>',
  '<p>one<br>\ntwo cat</p>',
  '<pre><code>cat\n  dog\n</code></pre>',
  '<ul>\n<li>cat</li>\n<li>dog <strong>cat</strong></li>\n</ul>',
  '<table><tr><td>cat</td><td>dog</td></tr></table>',
  '<div data-devot-island="">cat in a diagram</div>',
  '<h2>Cat</h2>',
  '<p>soft\nbreak cat</p>',
]

function preview(pieces: readonly number[]) {
  const root = document.createElement('article')
  const body = document.createElement('div')
  body.innerHTML = pieces.map((i) => PIECES[i]).join('\n')
  root.append(body)
  document.body.append(root)
  return { root, body }
}

afterEach(() => {
  document.body.replaceChildren()
})

type Mutation =
  | { kind: 'text'; at: number; text: string }
  | { kind: 'insert'; at: number; piece: number }
  | { kind: 'remove'; at: number }
  | { kind: 'replace'; at: number }
  | { kind: 'move'; at: number; to: number }
  | { kind: 'break'; at: number }
  | { kind: 'skip'; at: number }
  | { kind: 'skipBody' }

const mutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    kind: fc.constant('text' as const),
    at: fc.nat(),
    text: fc.constantFrom('cat', 'dog', '', '\n', ' cat cat ', 'ca'),
  }),
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    piece: fc.nat(PIECES.length - 1),
  }),
  fc.record({ kind: fc.constant('remove' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('replace' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('move' as const), at: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant('break' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('skip' as const), at: fc.nat() }),
  fc.record({ kind: fc.constant('skipBody' as const) }),
)

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
  return out
}

function apply(body: HTMLElement, m: Mutation) {
  const children = [...body.childNodes]
  const pick = <T>(list: readonly T[], at: number) =>
    list.length ? list[at % list.length] : undefined
  if (m.kind === 'text') {
    const node = pick(textNodes(body), m.at)
    if (node) node.data = m.text
  } else if (m.kind === 'insert') {
    const holder = document.createElement('div')
    holder.innerHTML = PIECES[m.piece]!
    body.insertBefore(holder.firstChild!, pick(children, m.at) ?? null)
  } else if (m.kind === 'remove') {
    pick(children, m.at)?.remove()
  } else if (m.kind === 'replace') {
    const node = pick(children, m.at)
    node?.parentNode?.replaceChild(node.cloneNode(true), node)
  } else if (m.kind === 'move') {
    const node = pick(children, m.at)
    if (node) body.insertBefore(node, pick(children, m.to) ?? null)
  } else if (m.kind === 'break') {
    const node = pick(textNodes(body), m.at)
    node?.parentNode?.insertBefore(document.createElement('br'), node)
  } else if (m.kind === 'skip') {
    const element = pick([...body.querySelectorAll('*')], m.at)
    element?.toggleAttribute('data-find-skip')
  } else {
    body.toggleAttribute('data-find-skip')
  }
}

type TextMap = ReturnType<ReturnType<typeof previewTextReader>['read']>

/** The reader's map, with each text node as its place in a fresh read (-1 when a fresh read has no such node). */
const placed = (map: TextMap, fresh: TextMap) => ({
  text: map.text,
  starts: map.starts,
  nodes: map.nodes.map((node) => fresh.nodes.indexOf(node)),
})
const inOrder = (map: TextMap) => ({
  text: map.text,
  starts: map.starts,
  nodes: map.nodes.map((_, i) => i),
})

describe('previewTextReader', () => {
  it('reads what a fresh read gives after any change to the preview', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(PIECES.length - 1), { maxLength: 8 }),
        fc.array(fc.array(mutation, { minLength: 1, maxLength: 3 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (pieces, batches) => {
          const { root, body } = preview(pieces)
          const reader = previewTextReader(root)
          const observer = new MutationObserver(() => {})
          reader.read()
          observer.observe(root, WATCHED)
          for (const batch of batches) {
            for (const m of batch) apply(body, m)
            reader.touched(observer.takeRecords())
            const again = previewTextReader(root).read()
            expect(placed(reader.read(), again)).toEqual(inOrder(again))
          }
          observer.disconnect()
          root.remove()
        },
      ),
      { numRuns: 400 },
    )
  })

  it('reads again only the piece a change touched', () => {
    const { root, body } = preview(Array.from({ length: 3000 }, (_, i) => i % PIECES.length))
    const reader = previewTextReader(root)
    const observer = new MutationObserver(() => {})
    reader.read()
    observer.observe(root, WATCHED)
    textNodes(body.children[1500]!)[0]!.data = 'a new cat'
    reader.touched(observer.takeRecords())
    const closest = vi.spyOn(Element.prototype, 'closest')
    const map = reader.read()
    // The line breaks between pieces are read every time; inside pieces, only the touched one is.
    expect(closest.mock.contexts.filter((element) => element !== body).length).toBeLessThan(20)
    closest.mockRestore()
    const again = previewTextReader(root).read()
    expect(placed(map, again)).toEqual(inOrder(again))
    observer.disconnect()
  })
})

describe('previewFindTarget', () => {
  it('counts the matches a fresh search counts as the preview changes', async () => {
    const { root, body } = preview([0, 1, 2, 3, 4])
    const target = previewFindTarget(root)
    const options = { query: 'cat', regexp: false, caseSensitive: false }
    target.search(options)
    target.next()
    expect(target.status()).toMatchObject({ total: 6, current: 1 })
    for (const m of [
      { kind: 'text', at: 0, text: 'cat cat' },
      { kind: 'insert', at: 2, piece: 7 },
      { kind: 'remove', at: 0 },
    ] as const) {
      apply(body, m)
      await Promise.resolve()
      const fresh = previewFindTarget(root)
      fresh.search(options)
      expect(target.status().total).toBe(fresh.status().total)
      fresh.clear()
    }
    expect(target.status().current).toBe(1)
    target.clear()
  })
})
