// Kept plugin drawings (ADR 0030): their key, the block they match, pruning and the caps, and the note's row on a
// real database.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import {
  blockHash,
  checkDrawings,
  drawingBlocks,
  drawingLanguages,
  findDrawing,
  keepDrawing,
  keepNoteDrawing,
  MAX_DRAWING_BYTES,
  MAX_NOTE_DRAWINGS,
  MAX_NOTE_DRAWINGS_BYTES,
  noteDrawings,
  pruneDrawings,
  pruneNoteDrawings,
  type KeptDrawing,
} from '../../src/core/plugins/drawings'
import { DRAWINGS_SQL, tempSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'

const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`

const drawn = (content: string, over: Partial<KeptDrawing> = {}): KeptDrawing => ({
  pluginId: 'com.example.graphviz',
  language: 'dot',
  hash: blockHash(content),
  appearance: 'light',
  svg: svg(content),
  ...over,
})

describe('the blocks a note holds', () => {
  it('reads each fenced block with a language as the preview does, in lists and quotes too', () => {
    const blocks = drawingBlocks(
      [
        '---',
        'title: x',
        '---',
        '',
        '```dot',
        'a -> b',
        '```',
        '',
        '- item',
        '',
        '  ~~~dot {attrs}',
        '  c -> d',
        '  ~~~',
        '',
        '> ```dot',
        '> e',
        '> ```',
        '',
        '```',
        'no language',
        '```',
        '',
      ].join('\n'),
    )
    expect(blocks).toEqual(
      new Set([
        `dot\n${blockHash('a -> b')}`,
        `dot\n${blockHash('c -> d')}`,
        `dot\n${blockHash('e')}`,
      ]),
    )
  })

  it('finds none in a note without fences', () => {
    expect(drawingBlocks('Just text.\n').size).toBe(0)
  })
})

describe('keeping a drawing', () => {
  it('adds it, replaces the one of the same key, and keeps light and dark apart', () => {
    const blocks = drawingBlocks('```dot\na\n```\n')
    const light = keepDrawing([], drawn('a'), blocks)!
    expect(light).toEqual([drawn('a')])
    const dark = keepDrawing(light, drawn('a', { appearance: 'dark' }), blocks)!
    expect(dark.map((d) => d.appearance)).toEqual(['light', 'dark'])
    const redrawn = keepDrawing(dark, drawn('a', { svg: svg('new') }), blocks)!
    expect(redrawn.map((d) => [d.appearance, d.svg])).toEqual([
      ['dark', svg('a')],
      ['light', svg('new')],
    ])
  })

  it('changes nothing for the drawing it holds already', () => {
    const blocks = drawingBlocks('```dot\na\n```\n')
    expect(keepDrawing([drawn('a')], drawn('a'), blocks)).toBeNull()
  })

  it('drops the drawings of blocks the note no longer holds', () => {
    const next = keepDrawing([drawn('old')], drawn('new'), drawingBlocks('```dot\nnew\n```\n'))
    expect(next).toEqual([drawn('new')])
  })

  it('keeps a drawing of the block just drawn though the stored body does not hold it yet', () => {
    expect(keepDrawing([], drawn('typed'), new Set())).toEqual([drawn('typed')])
  })

  it('does not keep a drawing past its cap, nor one past the note’s, and the others stay', () => {
    const huge = drawn('a', { svg: `<svg>${'x'.repeat(MAX_DRAWING_BYTES)}</svg>` })
    expect(keepDrawing([], huge, new Set())).toBeNull()
    const many = Array.from({ length: MAX_NOTE_DRAWINGS }, (_, i) => drawn(`b${i}`))
    const blocks = new Set(many.map((d) => `dot\n${d.hash}`))
    expect(keepDrawing(many, drawn('one more'), blocks)).toBeNull()
    const big = Array.from({ length: 4 }, (_, i) =>
      drawn(`c${i}`, { svg: `<svg>${'y'.repeat(MAX_DRAWING_BYTES - 20)}</svg>` }),
    )
    const bigBlocks = new Set(big.map((d) => `dot\n${d.hash}`))
    expect(keepDrawing(big, drawn('fifth'), bigBlocks)).toBeNull()
  })

  it('still drops gone blocks when the new drawing does not fit', () => {
    const huge = drawn('a', { svg: `<svg>${'x'.repeat(MAX_DRAWING_BYTES)}</svg>` })
    expect(keepDrawing([drawn('gone')], huge, new Set())).toEqual([])
  })
})

describe('finding a kept drawing', () => {
  it('matches the language, the content and the appearance, the plugin’s own first', () => {
    const list = [
      drawn('a'),
      drawn('a', { pluginId: 'org.other.dot' }),
      drawn('a', { appearance: 'dark' }),
    ]
    expect(
      findDrawing(list, { language: 'dot', content: 'a', appearance: 'light' })?.pluginId,
    ).toBe('org.other.dot')
    expect(
      findDrawing(list, {
        language: 'dot',
        content: 'a',
        appearance: 'light',
        pluginId: 'com.example.graphviz',
      })?.pluginId,
    ).toBe('com.example.graphviz')
    expect(
      findDrawing(list, { language: 'dot', content: 'a ', appearance: 'light' }),
    ).toBeUndefined()
    expect(findDrawing(list, { language: 'd2', content: 'a', appearance: 'light' })).toBeUndefined()
    expect(drawingLanguages([...list, drawn('x', { language: 'd2' })])).toEqual(['d2', 'dot'])
  })
})

describe('checking a list', () => {
  it('takes a well-formed list and refuses anything else', () => {
    expect(checkDrawings([drawn('a')])).toEqual([drawn('a')])
    expect(checkDrawings([])).toEqual([])
    for (const bad of [
      null,
      {},
      [drawn('a'), drawn('a')],
      [{ ...drawn('a'), extra: 1 }],
      [drawn('a', { hash: 'A'.repeat(64) })],
      [drawn('a', { appearance: 'sepia' as 'light' })],
      [drawn('a', { pluginId: 'devot.core' })],
      [drawn('a', { language: 'Dot Lang' })],
      [drawn('a', { svg: '' })],
      [drawn('a', { svg: 'x'.repeat(MAX_DRAWING_BYTES + 1) })],
      Array.from({ length: MAX_NOTE_DRAWINGS + 1 }, (_, i) => drawn(`n${i}`)),
    ]) {
      expect(checkDrawings(bad)).toBeNull()
    }
  })

  it('drops a removed drawing from what pruning keeps', () => {
    expect(pruneDrawings([drawn('a'), drawn('b')], drawingBlocks('```dot\nb\n```\n'))).toEqual([
      drawn('b'),
    ])
  })
})

describe('a note’s kept drawings in storage', () => {
  let storage: SqliteAdapter
  afterEach(() => storage.close())

  async function noteWith(body: string) {
    storage = tempSqliteAdapter('devot-drawings-')
    const clock = createClock('mac')
    const notes = createNoteService({ storage, clock, newId: createIdGenerator(), saveDelayMs: 5 })
    const id = await notes.create('Diagram')
    await notes.setBody(id, body)
    await notes.flush()
    return { id, clock, notes }
  }

  it('keeps two blocks drawn at once, each under a new clock', async () => {
    const { id, clock } = await noteWith('```dot\na\n```\n\n```dot\nb\n```\n')
    await Promise.all([
      keepNoteDrawing(storage, clock, id, drawn('a')),
      keepNoteDrawing(storage, clock, id, drawn('b')),
    ])
    expect((await noteDrawings(storage, id)).map((d) => d.svg).sort()).toEqual([svg('a'), svg('b')])
    const first = (await storage.getNoteDrawings(id))!.hlc
    expect(await keepNoteDrawing(storage, clock, id, drawn('a'))).toBe(false)
    expect((await storage.getNoteDrawings(id))!.hlc).toBe(first)
  })

  it('prunes the drawings of a block edited away, keeping the row and its clock', async () => {
    const { id, clock, notes } = await noteWith('```dot\na\n```\n')
    await keepNoteDrawing(storage, clock, id, drawn('a'))
    const before = (await storage.getNoteDrawings(id))!.hlc
    await notes.setBody(id, '```dot\na2\n```\n')
    await notes.flush()
    const pruned = await pruneNoteDrawings(storage, clock, id, (await storage.getNote(id))!.bodyMd)
    expect(pruned?.drawings).toEqual([])
    expect(pruned!.hlc > before).toBe(true)
    expect(await storage.getNoteDrawings(id)).toEqual(pruned)
  })

  it('keeps nothing for a note it does not hold', async () => {
    const { clock } = await noteWith('x')
    expect(
      await keepNoteDrawing(storage, clock, '0192a6f0-0000-7000-8000-00000000dead', drawn('a')),
    ).toBe(false)
  })

  it('refuses a list past the caps and a note it does not hold', async () => {
    const { id, clock } = await noteWith('x')
    const many = Array.from({ length: MAX_NOTE_DRAWINGS + 1 }, (_, i) => drawn(`n${i}`))
    await expect(
      storage.putNoteDrawings({ noteId: id, drawings: many, hlc: clock.tick() }),
    ).rejects.toThrow('E_NOTE_DRAWINGS_INVALID')
    await expect(
      storage.putNoteDrawings({
        noteId: '0192a6f0-0000-7000-8000-00000000dead',
        drawings: [],
        hlc: clock.tick(),
      }),
    ).rejects.toThrow('E_NOTE_NOT_FOUND')
  })

  it('marks the note pending for sync when its drawings change, and drops them with a purge', async () => {
    const { id, clock, notes } = await noteWith('```dot\na\n```\n')
    const [before] = await storage.syncRead([id])
    await keepNoteDrawing(storage, clock, id, drawn('a'))
    const [after] = await storage.syncRead([id])
    expect(after!.entry!.edits).toBeGreaterThan(before!.entry!.edits)
    expect(after!.note!.drawings?.drawings).toEqual([drawn('a')])
    await notes.trash(id)
    await storage.purgeNote(id, Date.now(), clock.tick())
    expect(await storage.getNoteDrawings(id)).toBeNull()
  })
})

it('runs the same statements as the Rust store', () => {
  const source = readFileSync('src-tauri/src/storage/drawings.rs', 'utf8')
  const statement = (name: string) =>
    new RegExp(`const ${name}: &str =\\s*"([^"]*)";`).exec(source)?.[1] ?? ''
  const words = (sql: string) => sql.split(/\s+/).join(' ')
  const names = {
    get: 'NOTE_DRAWINGS_GET_SQL',
    put: 'NOTE_DRAWINGS_PUT_SQL',
    drop: 'NOTE_DRAWINGS_DROP_SQL',
    live: 'NOTE_DRAWINGS_LIVE_SQL',
  } as const
  const keys = Object.keys(names) as (keyof typeof names)[]
  const rust = Object.fromEntries(keys.map((k) => [k, words(statement(names[k]))]))
  expect(rust).toEqual(Object.fromEntries(keys.map((k) => [k, words(DRAWINGS_SQL[k])])))
  expect(Object.values(rust).filter((sql) => sql === '')).toEqual([])
})

it('caps a drawing and a note as the Rust command does', () => {
  const source = readFileSync('src-tauri/src/commands/drawings.rs', 'utf8')
  expect(source).toContain(`const MAX_DRAWING_BYTES: usize = ${MAX_DRAWING_BYTES / 1024} * 1024;`)
  expect(source).toContain(`const MAX_NOTE_DRAWINGS: usize = ${MAX_NOTE_DRAWINGS};`)
  expect(source).toContain(
    `const MAX_NOTE_DRAWINGS_BYTES: usize = ${MAX_NOTE_DRAWINGS_BYTES / 1024} * 1024;`,
  )
})
