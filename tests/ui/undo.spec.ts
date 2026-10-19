import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import { expect, test } from './fixtures'

// The editor has one undo system, CodeMirror's history (docs/architecture.md, Merging and history): it holds the
// user's own edits, never what reaches the note from outside, and a note keeps it while another is shown.

const DB_CHANGED = 'devot:db-changed'
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) =>
  noteRows(page).filter({ has: page.locator('.row-title, .row-headline', { hasText: title }) })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

interface StoredNote {
  id: string
  title: string
  bodyMd: string
  ydoc: number[]
  /** Missing in a note stored before body versions: 0. */
  bodyVersion?: number
}

const storedNotes = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])

const savedBody = async (page: Page, title: string) =>
  (await storedNotes(page)).find((n) => n.title === title)?.bodyMd

/** Writes to the stored note's Yjs document behind the app's back, as another process would. */
async function editOutside(page: Page, title: string, edit: (doc: Y.Doc) => void) {
  const notes = await storedNotes(page)
  const note = notes.find((n) => n.title === title)
  if (!note) throw new Error(`no stored note ${title}`)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(note.ydoc))
  edit(doc)
  note.ydoc = Array.from(Y.encodeStateAsUpdate(doc))
  note.bodyMd = doc.getText('body').toString()
  note.bodyVersion = (note.bodyVersion ?? 0) + 1
  await page.evaluate((all) => localStorage.setItem('devot.test.notes', JSON.stringify(all)), notes)
  // Rust's `devot://db-changed`, as the page re-sends it.
  await page.evaluate((name) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent(name))
  }, DB_CHANGED)
}

async function createNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await body(page).click()
  await page.keyboard.type(text)
  await expect.poll(() => savedBody(page, title)).toBe(text)
}

async function show(page: Page, title: string) {
  await noteRow(page, title).click()
  await expect(titleField(page)).toHaveValue(title)
}

async function undo(page: Page, times: number) {
  for (let i = 0; i < times; i += 1) await page.keyboard.press('ControlOrMeta+z')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a change another process makes to the open note is not undone', async ({ page }) => {
  await createNote(page, 'Shared', 'Typed here.')
  await editOutside(page, 'Shared', (doc) => doc.getText('body').insert(0, 'From outside. '))
  await expect(body(page)).toHaveText('From outside. Typed here.')

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' More.')
  await undo(page, 6)
  await expect.poll(() => savedBody(page, 'Shared')).toBe('From outside. ')
})

test('undo goes on after switching to another note and back', async ({ page }) => {
  await createNote(page, 'First', 'Typed in first.')
  await createNote(page, 'Second', 'Typed in second.')
  await editOutside(page, 'First', (doc) => doc.getText('body').insert(0, 'Outside. '))
  await show(page, 'First')
  await expect(body(page)).toHaveText('Outside. Typed in first.')

  await body(page).click()
  await undo(page, 3)
  await expect.poll(() => savedBody(page, 'First')).toBe('Outside. ')

  await show(page, 'Second')
  await body(page).click()
  await undo(page, 3)
  await expect.poll(() => savedBody(page, 'Second')).toBe('')
})

test('undo goes on after more notes were shown than the core keeps in memory', async ({ page }) => {
  await createNote(page, 'Kept', 'Typed first.')
  // Nine other notes: the core lets the first one go from memory and reads it again.
  for (let i = 1; i <= 9; i += 1) await createNote(page, `Other ${i}`, `Note ${i}.`)
  await show(page, 'Kept')
  await expect(body(page)).toHaveText('Typed first.')
  await body(page).click()
  await undo(page, 3)
  await expect.poll(() => savedBody(page, 'Kept')).toBe('')
})
