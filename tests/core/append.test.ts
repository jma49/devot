// Appending text under a heading (issue #477), on real SQLite: the section rule, the separator rule, a missing heading refused,
// and the note service's edit as one Yjs update the editor applies as one undo step, with the text before kept as a version.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  appendedBody,
  appendInsertion,
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  findNoteByTitle,
  headingKeyOf,
  TEMPLATES_BOOK_ID,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const NOTE = '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n\n## Next\n- later\n'

describe('the section under a heading', () => {
  it('ends before the next heading of the same or a higher level', () => {
    expect(appendedBody(NOTE, '- two', { heading: 'Log', position: 'append' })).toBe(
      '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n- two\n\n## Next\n- later\n',
    )
    expect(appendedBody(NOTE, '- more', { heading: 'Detail', position: 'append' })).toBe(
      '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n- more\n\n## Next\n- later\n',
    )
    expect(appendedBody(NOTE, '- last', { heading: 'Next', position: 'append' })).toBe(
      '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n\n## Next\n- later\n- last\n',
    )
    expect(appendedBody(NOTE, '- end', { heading: 'Day', position: 'append' })).toBe(
      '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n\n## Next\n- later\n- end\n',
    )
  })

  it('prepends before the first line with content, keeping the blank line after the heading', () => {
    expect(appendedBody(NOTE, '- zero', { heading: 'Log', position: 'prepend' })).toBe(
      '# Day\n\n## Log\n- zero\n- one\n\n### Detail\n- deep\n\n## Next\n- later\n',
    )
    expect(
      appendedBody('## Log\n\n- one\n', '- zero', { heading: 'log', position: 'prepend' }),
    ).toBe('## Log\n\n- zero\n- one\n')
  })

  it('takes the heading in any case, with or without its marks, the first one found', () => {
    for (const heading of ['LOG', '## Log', '##  log  ', 'Log ##']) {
      expect(appendedBody(NOTE, 'x', { heading, position: 'append' })).toContain('- deep\nx\n')
    }
    expect(headingKeyOf('## Café ##')).toBe('café')
    const twice = '## Log\n- a\n\n## Log\n- b\n'
    expect(appendedBody(twice, '- c', { heading: 'Log', position: 'append' })).toBe(
      '## Log\n- a\n- c\n\n## Log\n- b\n',
    )
  })

  it('is empty right after its heading, so the text starts the next line whatever the separator', () => {
    expect(appendedBody('## Log\n## Next\n', 'x', { heading: 'Log', position: 'append' })).toBe(
      '## Log\nx\n## Next\n',
    )
    expect(
      appendedBody('## Log\n\n\n## Next\n', 'x', {
        heading: 'Log',
        position: 'prepend',
        separator: 'none',
      }),
    ).toBe('## Log\nx\n\n\n## Next\n')
    expect(appendedBody('## Log', 'x', { heading: 'Log', position: 'append' })).toBe('## Log\nx')
  })

  it('is not closed by a fence line with text after it, and a backtick fence with a backtick in its info is none', () => {
    const open = '## Log\n```sh\n```still-code\n## Not a heading\n```\n- one\n'
    expect(() => appendedBody(open, 'x', { heading: 'Not a heading', position: 'append' })).toThrow(
      'E_HEADING_NOT_FOUND',
    )
    const unfenced = '## Log\n``` a ` b\n## Real\n- one\n'
    expect(appendedBody(unfenced, 'x', { heading: 'Real', position: 'append' })).toBe(
      '## Log\n``` a ` b\n## Real\n- one\nx\n',
    )
    const tilde = '~~~ a ` b\n## Hidden\n~~~\n## Shown\n'
    expect(() => appendedBody(tilde, 'x', { heading: 'Hidden', position: 'append' })).toThrow(
      'E_HEADING_NOT_FOUND',
    )
  })

  it('is not opened by a heading inside a fenced code block', () => {
    const fenced = '## Log\n```sh\n# a comment\n## not a heading\n```\n- one\n\n## Next\n'
    expect(() => appendedBody(fenced, 'x', { heading: 'a comment', position: 'append' })).toThrow(
      'E_HEADING_NOT_FOUND',
    )
    expect(appendedBody(fenced, '- two', { heading: 'Log', position: 'append' })).toBe(
      '## Log\n```sh\n# a comment\n## not a heading\n```\n- one\n- two\n\n## Next\n',
    )
  })

  it('refuses a heading the note does not have, and a blank text', () => {
    for (const heading of ['Missing', '', '#', 'Lo']) {
      expect(() => appendInsertion(NOTE, 'x', { heading, position: 'append' })).toThrow(
        'E_HEADING_NOT_FOUND',
      )
    }
    expect(() => appendInsertion(NOTE, '  \n', { position: 'append' })).toThrow(
      'E_APPEND_TEXT_EMPTY',
    )
  })
})

describe('the separator rule', () => {
  it('puts the text on a line of its own, or joins it to the line it lands on', () => {
    expect(appendedBody('a\nb\n\n', 'c', { position: 'append' })).toBe('a\nb\nc\n\n')
    expect(appendedBody('a\nb', 'c', { position: 'append', separator: 'none' })).toBe('a\nbc')
    expect(appendedBody('\na\n', 'c', { position: 'prepend' })).toBe('\nc\na\n')
    expect(appendedBody('a\n', 'c', { position: 'prepend', separator: 'none' })).toBe('ca\n')
    expect(appendedBody('', 'c', { position: 'append' })).toBe('c')
    expect(appendedBody('\n\n', 'c', { position: 'prepend' })).toBe('c\n\n')
  })

  it('drops the line breaks a shell leaves at the end of the text, and reads CRLF as LF', () => {
    expect(appendedBody('a\n', 'b\r\nc\n\n', { position: 'append' })).toBe('a\nb\nc\n')
  })
})

describe('a note named by title', () => {
  const note = (id: string, title: string, bookId: string | null = 'b') => ({
    id,
    title,
    bookId,
    updatedAt: 1,
  })

  it('is the exact match, else the one differing only in case, never a template', () => {
    const notes = [note('1', 'Daily'), note('2', 'daily'), note('3', 'Plan', TEMPLATES_BOOK_ID)]
    expect(findNoteByTitle(notes, 'Daily')).toBe('1')
    expect(findNoteByTitle(notes, 'daily')).toBe('2')
    expect(() => findNoteByTitle(notes, 'DAILY')).toThrow('E_NOTE_TITLE_AMBIGUOUS')
    expect(findNoteByTitle([note('1', 'Daily')], 'DAILY')).toBe('1')
    expect(findNoteByTitle([note('1', 'Café')], 'Café')).toBe('1')
    expect(() => findNoteByTitle(notes, 'Plan')).toThrow('E_NOTE_NOT_FOUND')
    expect(() => findNoteByTitle(notes, '')).toThrow('E_NOTE_NOT_FOUND')
    expect(() => findNoteByTitle([...notes, note('4', 'Daily')], 'Daily')).toThrow(
      'E_NOTE_TITLE_AMBIGUOUS',
    )
  })
})

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function service() {
  const storage = openSqliteAdapter(join(tempDir('devot-append-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  return { storage, notes }
}

async function editorFor(notes: ReturnType<typeof service>['notes'], id: string) {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, (await notes.open(id)).state, 'remote')
  return { doc, text: doc.getText(BODY) }
}

describe('the note service', () => {
  it('appends under the heading as one update the editor applies as one undo step, and keeps the text before as a version', async () => {
    const { storage, notes } = service()
    const id = await notes.create('Day')
    await notes.setBody(id, NOTE)
    await notes.flush()
    const editor = await editorFor(notes, id)
    const update = await notes.appendToNote(id, '- two', { heading: 'Log', position: 'append' })
    let transactions = 0
    editor.doc.on('afterTransaction', () => (transactions += 1))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(transactions).toBe(1)
    const expected = '# Day\n\n## Log\n- one\n\n### Detail\n- deep\n- two\n\n## Next\n- later\n'
    expect(editor.text.toString()).toBe(expected)
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe(expected)
    const versions = (await storage.listRevisions(id)).filter((r) => r.kind === 'body')
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(await notes.revisionText(id, versions[versions.length - 1]!.id)).toBe(NOTE)
  })

  it('lands where typing meanwhile moved the section', async () => {
    const { notes } = service()
    const id = await notes.create()
    await notes.setBody(id, '## Log\n- one\n')
    const editor = await editorFor(notes, id)
    const update = await notes.appendToNote(id, '- two', { heading: 'Log', position: 'append' })
    editor.doc.transact(() => editor.text.insert(0, '# Day\n'))
    Y.applyUpdate(editor.doc, update, 'restore')
    expect(editor.text.toString()).toBe('# Day\n## Log\n- one\n- two\n')
  })

  it('refuses a missing heading with its code and changes nothing', async () => {
    const { storage, notes } = service()
    const id = await notes.create()
    await notes.setBody(id, '## Log\n- one\n')
    await notes.flush()
    await expect(
      notes.appendToNote(id, '- two', { heading: 'Missing', position: 'append' }),
    ).rejects.toThrow('E_HEADING_NOT_FOUND')
    await notes.flush()
    expect((await storage.getNote(id))!.bodyMd).toBe('## Log\n- one\n')
    await expect(
      notes.appendToNote('01890a5d-ac96-774b-bcce-b302099a8057', 'x', { position: 'append' }),
    ).rejects.toThrow('E_NOTE_NOT_FOUND')
  })
})
