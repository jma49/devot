import type { BrowserContext, Page } from '@playwright/test'
import { expect, mockTauri, openApp, pickMenuItem, test, type TestWindow } from './fixtures'

// A note in a window of its own (note.html, src-tauri/src/note_window.rs). Rust opens the window and
// carries the relay; here `note_window_note` is mocked, and both pages of one browser share the
// in-memory storage (localStorage) and the relay (a BroadcastChannel in the UI tests' build).

const CLOSE_EVENT = 'devot:note-window-close'

const storedNotes = () =>
  JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
    id: string
    title: string
    bodyMd: string
  }[]

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const title = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const rows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

/** Makes a note in the main window, typed and saved; returns its ID. */
async function noteInMain(page: Page, name: string, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await title(page).fill(name)
  await body(page).click()
  await page.keyboard.type(text)
  await expect
    .poll(() => page.evaluate(storedNotes).then((notes) => notes.find((n) => n.title === name)))
    .toMatchObject({ bodyMd: text })
  const notes = await page.evaluate(storedNotes)
  return notes.find((n) => n.title === name)!.id
}

async function openNoteWindow(context: BrowserContext, id: string) {
  const win = await context.newPage()
  await mockTauri(win)
  await win.addInitScript((noteId) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      note_window_note: noteId,
      note_window_open: null,
      note_window_close_ready: null,
      note_window_close_cancel: null,
      app_exit_ready: null,
      app_exit_cancel: null,
    }
  }, id)
  await win.goto('/note.html')
  await win.locator('.window[data-ready]').waitFor()
  return win
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await openApp(page)
})

test('Shift-Return on a note in the list, or Open in New Window, opens it in a window of its own', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, note_window_open: null }
  })
  const id = await noteInMain(page, 'Plan', 'Steps')
  await rows(page).first().focus()
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => calls(page, 'note_window_open')).toEqual([{ id }])
  await rows(page).first().click({ button: 'right' })
  await pickMenuItem(page, 'Open in New Window')
  await expect.poll(() => calls(page, 'note_window_open')).toEqual([{ id }, { id }])
})

test('a note window shows the title, the editor and the preview, and is named after the note', async ({
  page,
  context,
}) => {
  const id = await noteInMain(page, 'Plan', 'First *step*')
  const win = await openNoteWindow(context, id)
  await expect(title(win)).toHaveValue('Plan')
  await expect(body(win)).toContainText('First *step*')
  await expect(win).toHaveTitle('Plan')
  await win.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(win.getByRole('article', { name: 'Preview' }).locator('em')).toHaveText('step')
  await expect(body(win)).toBeHidden()
  await win.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(body(win)).toBeVisible()
  await expect(win.getByRole('article', { name: 'Preview' })).toBeVisible()
})

test('typing in either window shows in the other at once, and both are saved', async ({
  page,
  context,
}) => {
  const id = await noteInMain(page, 'Plan', 'Start.')
  const win = await openNoteWindow(context, id)
  await body(win).click()
  await win.keyboard.press('End')
  await win.keyboard.type(' From the window.')
  await expect(body(page)).toContainText('Start. From the window.')

  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' From the main window.')
  await expect(body(win)).toContainText('Start. From the window. From the main window.')

  await expect
    .poll(() => page.evaluate(storedNotes).then((notes) => notes.find((n) => n.id === id)?.bodyMd))
    .toBe('Start. From the window. From the main window.')
})

test('a title changed in the note window shows in the main window', async ({ page, context }) => {
  const id = await noteInMain(page, 'Plan', 'Body')
  const win = await openNoteWindow(context, id)
  await title(win).fill('Renamed')
  await expect(title(page)).toHaveValue('Renamed')
  await expect(rows(page).first()).toContainText('Renamed')
  await expect(win).toHaveTitle('Renamed')
})

test('closing a note window saves its edits first', async ({ page, context }) => {
  const id = await noteInMain(page, 'Plan', 'Start.')
  // The main window moves on to another note: what is stored is the note window's own save.
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const win = await openNoteWindow(context, id)
  await body(win).click()
  await win.keyboard.press('End')
  await win.keyboard.type(' Typed just before closing.')
  await win.evaluate((name) => {
    const w = globalThis as unknown as { dispatchEvent(e: unknown): void }
    const make = globalThis as unknown as { CustomEvent: new (t: string) => unknown }
    w.dispatchEvent(new make.CustomEvent(name))
  }, CLOSE_EVENT)
  await expect.poll(() => calls(win, 'note_window_close_ready')).toHaveLength(1)
  const stored = await win.evaluate(storedNotes)
  expect(stored.find((n) => n.id === id)?.bodyMd).toBe('Start. Typed just before closing.')
})
