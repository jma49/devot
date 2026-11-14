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
  findMention,
  mentionExcerpt,
  noteLink,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Built from code points so the file holds no CJK characters.
const HAN = String.fromCodePoint(0x5b66, 0x4e60, 0x6cd5)
const HAN_AROUND = `${String.fromCodePoint(0x6211)}${HAN}${String.fromCodePoint(0x4e86)}`

const at = (body: string, title: string) => {
  const found = findMention(body, title)
  return found ? body.slice(found.from, found.to) : null
}

describe('findMention', () => {
  it('finds the title as whole words in any case, across a line break', () => {
    expect(at('We met at the Weekly plan meeting', 'weekly plan')).toBe('Weekly plan')
    expect(at('the weekly\nplan', 'Weekly plan')).toBe('weekly\nplan')
    expect(at('Biweekly planning', 'Weekly plan')).toBeNull()
    expect(at('cats and a cat', 'cat')).toBe('cat')
  })

  it('finds a title in a script that runs words together anywhere in the text', () => {
    expect(at(HAN_AROUND, HAN)).toBe(HAN)
  })

  it('never counts front matter, code, links, images, HTML or URLs', () => {
    const body = [
      '---',
      'title: Garden',
      '---',
      '`Garden` and [Garden](https://example.com) and ![Garden](devot://file/x)',
      '<span title="Garden">x</span> https://example.com/Garden <!-- Garden -->',
      '```',
      'Garden',
      '```',
      '[Garden]: https://example.com',
    ].join('\n')
    expect(findMention(body, 'Garden')).toBeNull()
    expect(at(`${body}\n\nThe Garden grows`, 'Garden')).toBe('Garden')
  })

  it('looks for no title too short for the search index', () => {
    expect(findMention('an ox', 'ox')).toBeNull()
    expect(findMention('anything', '   ')).toBeNull()
  })

  it('keeps an excerpt to the line around the mention', () => {
    const body = `first line\n${'x '.repeat(100)}Garden${' y'.repeat(100)}\nlast`
    const excerpt = mentionExcerpt(body, findMention(body, 'Garden')!)
    expect(excerpt).toContain('Garden')
    expect(excerpt).not.toContain('first line')
    expect(excerpt.length).toBeLessThanOrEqual(122)
  })
})

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-mentions-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  return { notes, templates }
}

async function write(notes: ReturnType<typeof setup>['notes'], id: string, text: string) {
  const opened = await notes.open(id)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, opened.state)
  const before = Y.encodeStateVector(doc)
  doc.getText(BODY).insert(0, text)
  await notes.applyUpdate(id, Y.encodeStateAsUpdate(doc, before))
  await notes.flush()
}

const bodyOf = async (notes: ReturnType<typeof setup>['notes'], id: string) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state)
  return doc.getText(BODY).toString()
}

describe('unlinked mentions of a note', () => {
  it('lists the live notes naming its title as text, never itself, a linking note, the Trash or Templates', async () => {
    const { notes, templates } = setup()
    const target = await notes.create('Garden plan')
    const naming = await notes.create('Naming')
    const linking = await notes.create('Linking')
    const trashed = await notes.create('Trashed')
    const inCode = await notes.create('In code')
    await write(notes, target, 'The Garden plan itself')
    await write(notes, naming, 'Spring:\nwe follow the garden plan this year')
    await write(notes, linking, `the Garden plan, see ${noteLink('Garden plan', target)}`)
    await write(notes, trashed, 'Garden plan')
    await write(notes, inCode, '`Garden plan`')
    await notes.trash(trashed)
    const template = await templates.create('Template')
    await write(notes, template, 'Garden plan')

    const found = await notes.mentions(target)
    expect(found.map((n) => n.id)).toEqual([naming])
    expect(found[0]?.excerpt).toBe('we follow the garden plan this year')
  })

  it('links the first mention in place, keeping its text, and then lists it no more', async () => {
    const { notes } = setup()
    const target = await notes.create('Garden plan')
    const naming = await notes.create('Naming')
    await write(notes, naming, '`Garden plan` then the garden plan, and Garden plan')

    await notes.linkMention(naming, target)
    await notes.flush()
    expect(await bodyOf(notes, naming)).toBe(
      `\`Garden plan\` then the ${noteLink('garden plan', target)}, and Garden plan`,
    )
    expect(await notes.mentions(target)).toEqual([])
    await expect(notes.linkMention(naming, target)).rejects.toThrow('E_MENTION_NOT_FOUND')
  })
})
