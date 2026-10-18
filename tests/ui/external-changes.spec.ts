import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import { expect, test } from './fixtures'

// devot-mcp writes to the database while Devot runs; Rust notices and sends
// `devot://db-changed`, which the page re-sends as this window event.
const DB_CHANGED = 'devot:db-changed'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })

/** Writes a note into storage behind the app's back, as another process would. */
async function writeOutside(page: Page, title: string, body: string, bookId: string | null) {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  const ydoc = Array.from(Y.encodeStateAsUpdate(doc))
  await page.evaluate(
    (note) => {
      const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as object[]
      const hlc = '0000000000000001-0000-mcptest'
      notes.push({
        id: '0192a6f0-0000-7000-8000-00000000abcd',
        title: note.title,
        titleHlc: hlc,
        bodyMd: note.body,
        ydoc: note.ydoc,
        bookId: note.bookId,
        bookHlc: hlc,
        status: 'none',
        statusHlc: '',
        pinned: false,
        pinnedHlc: '',
        bodyVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        deletedHlc: null,
      })
      localStorage.setItem('devot.test.notes', JSON.stringify(notes))
    },
    { title, body, bookId, ydoc },
  )
}

const signalChange = (page: Page) =>
  page.evaluate((name) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent(name))
  }, DB_CHANGED)

/** Lets pending timers, worker round trips and renders run. */
const settle = (page: Page) => page.waitForTimeout(500)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a note written by another process shows up when the database changes', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Inbox')
  await field.press('Enter')
  const inbox = tree(page).getByRole('treeitem', { name: /^Inbox\b/ })
  await expect(inbox).toBeVisible()
  await expect(noteRows(page)).toHaveCount(0)
  const bookId = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as { id: string }[])[0]!.id,
  )

  await writeOutside(page, 'From Claude', 'Written by devot-mcp.', bookId)
  // Nothing reloads by itself: give a reload time to happen, then look once.
  await settle(page)
  expect(await noteRows(page).count()).toBe(0)
  // ...until the change is announced.
  await signalChange(page)
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).first()).toContainText('From Claude')
  await expect(inbox.locator('> .book-row .source-count')).toHaveText('1')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await expect(noteRows(page)).toHaveCount(1)

  // It opens with its body, like any note.
  await noteRows(page).first().click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('From Claude')
  await expect(page.getByRole('textbox', { name: 'Note body' })).toContainText(
    'Written by devot-mcp.',
  )
})

test('a change while a note is open keeps it open and its edits', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Title' })
  await expect(title).toHaveValue('')
  await title.fill('Mine')
  // The title is not saved yet; the list row already shows it.
  await expect(noteRows(page).filter({ hasText: 'Mine' })).toHaveCount(1)
  await writeOutside(page, 'From Claude', 'Written by devot-mcp.', null)
  await signalChange(page)
  // The outside note appears only once the reload has run...
  await expect(noteRows(page)).toHaveCount(2)
  // ...and the reload read the saved title back: the edit was flushed first.
  // Looked at once, so a later save cannot make it pass.
  expect(await noteRows(page).filter({ hasText: 'Mine' }).count()).toBe(1)
  expect(await title.inputValue()).toBe('Mine')
  await expect(title).toBeFocused()
  // Nothing reverts once things settle.
  await settle(page)
  expect(await noteRows(page).filter({ hasText: 'Mine' }).count()).toBe(1)
  expect(await title.inputValue()).toBe('Mine')
})

interface StoredNote {
  id: string
  title: string
  titleHlc: string
  bodyMd: string
  ydoc: number[]
  /** Missing in a note stored before body versions: 0. */
  bodyVersion?: number
}

const storedNotes = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])

/**
 * Edits the stored note `id` behind the app's back, as another process
 * would: `edit` changes its Yjs document (so the change merges with the
 * app's) and storage moves its body version on, and a `title` replaces its
 * title with a newer timestamp.
 */
async function editOutside(page: Page, id: string, edit: (doc: Y.Doc) => void, title?: string) {
  const notes = await storedNotes(page)
  const note = notes.find((n) => n.id === id)
  if (!note) throw new Error(`no stored note ${id}`)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(note.ydoc))
  edit(doc)
  note.ydoc = Array.from(Y.encodeStateAsUpdate(doc))
  note.bodyMd = doc.getText('body').toString()
  note.bodyVersion = (note.bodyVersion ?? 0) + 1
  if (title !== undefined) {
    note.title = title
    note.titleHlc = `${String(Date.now() + 1000).padStart(16, '0')}-0000-mcptest`
  }
  await page.evaluate((all) => localStorage.setItem('devot.test.notes', JSON.stringify(all)), notes)
}

test('the open note takes in what another process wrote to it', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Title' })
  const body = page.getByRole('textbox', { name: 'Note body' })
  await title.fill('Shared')
  await body.click()
  await page.keyboard.type('Typed here.')
  // Saved, so the other process starts from it.
  await expect.poll(async () => (await storedNotes(page))[0]?.bodyMd).toBe('Typed here.')
  const [{ id }] = (await storedNotes(page)) as [StoredNote]

  await editOutside(page, id, (doc) => doc.getText('body').insert(0, 'From Claude. '), 'Renamed')
  await signalChange(page)
  await expect(body).toHaveText('From Claude. Typed here.')
  await expect(title).toHaveValue('Renamed')
  await expect(noteRows(page).filter({ hasText: 'Renamed' })).toHaveCount(1)

  // Typing goes on in the editor; the save keeps both.
  await body.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' More.')
  await expect
    .poll(async () => (await storedNotes(page))[0]?.bodyMd)
    .toBe('From Claude. Typed here. More.')
  expect((await storedNotes(page))[0]?.title).toBe('Renamed')
})

test('typing saved before the window hears of an outside write keeps both', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Note body' })
  await page.getByRole('textbox', { name: 'Title' }).fill('Shared')
  await body.click()
  await page.keyboard.type('Typed here.')
  await expect.poll(async () => (await storedNotes(page))[0]?.bodyMd).toBe('Typed here.')
  const [{ id }] = (await storedNotes(page)) as [StoredNote]

  // Another process writes to the note; the window types and saves before
  // it hears of that write.
  await editOutside(page, id, (doc) => doc.getText('body').insert(0, 'From Claude. '))
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' More.')
  await expect
    .poll(async () => (await storedNotes(page))[0]?.bodyMd)
    .toBe('From Claude. Typed here. More.')

  // Once it hears, the editor shows both.
  await signalChange(page)
  await expect(body).toHaveText('From Claude. Typed here. More.')
})

/** The text selected in the page (the editor's selection while it has focus). */
const selectedText = (page: Page) =>
  page.evaluate(() => String((globalThis as unknown as { getSelection(): unknown }).getSelection()))

test('an outside edit to the open note keeps the caret, the selection and undo', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const body = page.getByRole('textbox', { name: 'Note body' })
  await page.getByRole('textbox', { name: 'Title' }).fill('Shared')
  await body.click()
  await page.keyboard.type('Alpha Beta Gamma')
  await expect.poll(async () => (await storedNotes(page))[0]?.bodyMd).toBe('Alpha Beta Gamma')
  const [{ id }] = (await storedNotes(page)) as [StoredNote]
  // Select "Beta", in the middle of the text.
  await page.keyboard.press('End')
  for (let i = 0; i < ' Gamma'.length; i += 1) await page.keyboard.press('ArrowLeft')
  for (let i = 0; i < 'Beta'.length; i += 1) await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => selectedText(page)).toBe('Beta')

  // devot-mcp's update_note: text lands before and after the selection.
  await editOutside(page, id, (doc) => {
    const text = doc.getText('body')
    text.insert(text.length, ' End.')
    text.insert(0, 'Start. ')
  })
  await signalChange(page)
  await expect(body).toHaveText('Start. Alpha Beta Gamma End.')
  // The selection moved with its text and the editor kept focus.
  await expect(body).toBeFocused()
  expect(await selectedText(page)).toBe('Beta')
  await settle(page)

  // Typing replaces the selection where it is now.
  await page.keyboard.type('X')
  await expect(body).toHaveText('Start. Alpha X Gamma End.')
  // Undo takes back only the typing: the outside text stays, the selection returns.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body).toHaveText('Start. Alpha Beta Gamma End.')
  await expect
    .poll(async () => (await storedNotes(page))[0]?.bodyMd)
    .toBe('Start. Alpha Beta Gamma End.')
  // Undo never takes back the outside edit.
  for (let i = 0; i < 20; i += 1) await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await storedNotes(page))[0]?.bodyMd).toBe('Start.  End.')
})
