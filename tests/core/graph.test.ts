import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  graphOf,
  layoutGraph,
  linkGraphView,
  MAX_GRAPH_LINKS,
  noteLink,
  type LinkGraph,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const raw = (links: [string, string][], titles: Record<string, string> = {}): LinkGraph => ({
  notes: [...new Set(links.flat())]
    .sort()
    .map((id) => ({ id, title: titles[id] ?? id.toUpperCase() })),
  links,
})

describe('graphOf', () => {
  it('makes each link one undirected edge between the notes, counting their links', () => {
    const graph = graphOf(
      raw([
        ['a', 'b'],
        ['b', 'a'],
        ['b', 'c'],
      ]),
    )
    expect(graph.notes.map((n) => [n.id, n.title, n.links])).toEqual([
      ['a', 'A', 1],
      ['b', 'B', 2],
      ['c', 'C', 1],
    ])
    expect(graph.links).toEqual([
      [0, 1],
      [1, 2],
    ])
    expect(graph.capped).toBe(false)
  })

  it('keeps only the notes within two links of the focus, or the focus alone', () => {
    const links: [string, string][] = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['x', 'y'],
    ]
    expect(graphOf(raw(links), { focus: 'a' }).notes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
    const alone = graphOf(raw(links), { focus: 'lone', focusTitle: 'Lone' })
    expect(alone.notes).toEqual([{ id: 'lone', title: 'Lone', links: 0 }])
    expect(alone.links).toEqual([])
  })

  it('keeps the most linked notes past the limit, the focus always, and says it is capped', () => {
    const links: [string, string][] = [
      ['hub', 'a'],
      ['hub', 'b'],
      ['hub', 'c'],
      ['d', 'e'],
    ]
    const graph = graphOf(raw(links), { limit: 2 })
    expect(graph.capped).toBe(true)
    expect(graph.notes.map((n) => n.id)).toEqual(['a', 'hub'])
    const local = graphOf(raw(links), { focus: 'c', limit: 2 })
    expect(local.notes.map((n) => n.id)).toContain('c')
    expect(
      graphOf(
        raw(Array.from({ length: MAX_GRAPH_LINKS }, (_, i) => [`n${i}`, 'z'] as [string, string])),
      ).capped,
    ).toBe(true)
  })
})

describe('layoutGraph', () => {
  it('is the same every time and centres on the origin', () => {
    const links: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 0],
      [3, 4],
    ]
    const one = layoutGraph(6, links)
    const two = layoutGraph(6, links)
    expect([...one.x]).toEqual([...two.x])
    const mean = [...one.x].reduce((a, b) => a + b, 0) / 6
    expect(Math.abs(mean)).toBeLessThan(1e-6)
  })

  it('puts linked notes nearer each other than notes linked to nothing', () => {
    const { x, y } = layoutGraph(12, [[0, 1]])
    const d = (a: number, b: number) => Math.hypot(x[a]! - x[b]!, y[a]! - y[b]!)
    const others: number[] = []
    for (let i = 2; i < 12; i += 1) others.push(d(0, i))
    expect(d(0, 1)).toBeLessThan(Math.min(...others))
    expect([...x, ...y].every(Number.isFinite)).toBe(true)
  })
})

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

describe('the link graph of a library', () => {
  it('links the live notes outside Templates, named by their titles', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-graph-'), 'devot.sqlite'))
    open.push(storage)
    const clock = createClock('mac1')
    const newId = createIdGenerator()
    const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
    const books = createBookService({ storage, clock, newId })
    const tags = createTagService({ storage, clock, newId })
    const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
    const write = async (id: string, text: string) => {
      const opened = await notes.open(id)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, opened.state)
      const before = Y.encodeStateVector(doc)
      doc.getText(BODY).insert(0, text)
      await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
      await notes.flush()
    }
    const a = await notes.create('Alpha')
    const b = await notes.create('Beta')
    const gone = await notes.create('Gone')
    const lone = await notes.create('Lone')
    const template = await templates.create('Template')
    await write(a, `${noteLink('Beta', b)} ${noteLink('Gone', gone)}`)
    await write(template, noteLink('Alpha', a))
    await notes.trash(gone)

    const graph = await notes.linkGraph()
    expect(graph.notes.map((n) => n.title).sort()).toEqual(['Alpha', 'Beta'])
    expect(graph.links).toHaveLength(1)
    const local = await notes.linkGraph(lone)
    expect(local.notes.map((n) => n.title)).toEqual(['Lone'])
  })
})

describe('linkGraphView', () => {
  it('gives every note a whole-number place', () => {
    const view = linkGraphView(
      raw([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    )
    expect(view.notes.every((n) => Number.isInteger(n.x) && Number.isInteger(n.y))).toBe(true)
  })
})
