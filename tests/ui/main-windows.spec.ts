import type { BrowserContext, Page } from '@playwright/test'
import {
  expect,
  mockTauri,
  openApp,
  pickNoteMore,
  pickStatus,
  statusPicker,
  test,
  type TestWindow,
} from './fixtures'

// File > New Window opens another main window (src-tauri/src/main_windows.rs). Rust builds it; here the
// second page is a `main-2` page of one browser, sharing the in-memory storage (localStorage) and the
// relays (BroadcastChannels in the UI tests' build) with the first.

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
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

async function noteIn(page: Page, name: string, text: string) {
  const before = await rows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(rows(page)).toHaveCount(before + 1)
  await title(page).fill(name)
  await body(page).click()
  await page.keyboard.type(text)
  await expect
    .poll(() => page.evaluate(storedNotes).then((notes) => notes.find((n) => n.title === name)))
    .toMatchObject({ bodyMd: text })
  return (await page.evaluate(storedNotes)).find((n) => n.title === name)!.id
}

async function openSecondWindow(context: BrowserContext, label = 'main-2') {
  const win = await context.newPage()
  await mockTauri(win)
  await win.addInitScript((windowLabel) => {
    const w = globalThis as unknown as TestWindow
    w.devotWindowLabel = windowLabel
    w.devotIpcMocks = {
      note_window_close_ready: null,
      note_window_close_cancel: null,
      main_windows_changed: null,
      app_exit_ready: null,
      app_exit_cancel: null,
    }
  }, label)
  await openApp(win)
  return win
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await openApp(page)
})

test('New Window in the palette asks Rust for another main window', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, main_window_new: null }
  })
  await page.keyboard.press('ControlOrMeta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('new window')
  await palette.getByRole('option', { name: /New Window/ }).click()
  await expect.poll(() => calls(page, 'main_window_new')).toHaveLength(1)
})

test('each window keeps its own note and library view', async ({ page, context }) => {
  await noteIn(page, 'Alpha', 'first')
  await noteIn(page, 'Beta', 'second')
  const win = await openSecondWindow(context)
  await expect(rows(win)).toHaveCount(2)
  // A new window starts with no note open; the first still has Beta.
  await expect(title(win)).toHaveCount(0)
  await expect(title(page)).toHaveValue('Beta')

  await rows(win).filter({ hasText: 'Alpha' }).click()
  await expect(title(win)).toHaveValue('Alpha')
  await expect(title(page)).toHaveValue('Beta')

  // The first window's Trash view does not move the second.
  await trashRow(page).click()
  await expect(page.locator('.list .headline')).toHaveText('Trash')
  await expect(win.locator('.list .headline')).not.toHaveText('Trash')
  await expect(title(win)).toHaveValue('Alpha')
})

test('a window File > New Window opened keeps its view in its own session, not the app’s storage', async ({
  page,
  context,
}) => {
  await noteIn(page, 'Alpha', 'first')
  const win = await openSecondWindow(context)
  await rows(win).filter({ hasText: 'Alpha' }).click()
  await expect(title(win)).toHaveValue('Alpha')
  await win.getByRole('button', { name: 'Focus Mode' }).click()
  await expect
    .poll(() => win.evaluate(() => Object.keys(sessionStorage).filter((k) => k.includes('main-2'))))
    .not.toEqual([])
  const local = await page.evaluate(() => Object.keys(localStorage))
  expect(local.filter((key) => key.includes('main-2'))).toEqual([])
})

test('two windows on the same note stay consistent while either types', async ({
  page,
  context,
}) => {
  await noteIn(page, 'Plan', 'Start.')
  const win = await openSecondWindow(context)
  await rows(win).filter({ hasText: 'Plan' }).click()
  await expect(body(win)).toContainText('Start.')

  await body(win).click()
  await win.keyboard.press('End')
  await win.keyboard.type(' From the second.')
  await expect(body(page)).toContainText('Start. From the second.')

  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' From the first.')
  await expect(body(win)).toContainText('Start. From the second. From the first.')

  await title(win).fill('Renamed')
  await expect(title(page)).toHaveValue('Renamed')
  await expect(rows(page).first()).toContainText('Renamed')
  await expect
    .poll(() => page.evaluate(storedNotes).then((notes) => notes[0]?.bodyMd))
    .toBe('Start. From the second. From the first.')
})

test('windows settle: once nobody types, nothing is written any more', async ({
  page,
  context,
}) => {
  await noteIn(page, 'Plan', 'Start.')
  const win = await openSecondWindow(context)
  await rows(win).filter({ hasText: 'Plan' }).click()
  await body(win).click()
  await win.keyboard.press('End')
  await win.keyboard.type(' More.')
  await expect(body(page)).toContainText('Start. More.')
  const written = () => page.evaluate(() => localStorage.getItem('devot.test.notes'))
  await expect.poll(written).toContain('Start. More.')
  // The lists reload 400 ms after the news, and the news waits 250 ms: a second is ample.
  await page.waitForTimeout(1500)
  const settled = await written()
  await page.waitForTimeout(1500)
  expect(await written()).toBe(settled)
})

test('a note made or changed in one window shows in the other’s list', async ({
  page,
  context,
}) => {
  await noteIn(page, 'Alpha', 'first')
  const win = await openSecondWindow(context)
  await expect(rows(win)).toHaveCount(1)

  await noteIn(page, 'Beta', 'second')
  await expect(rows(win)).toHaveCount(2)
  await expect(rows(win).filter({ hasText: 'Beta' })).toHaveCount(1)

  await pickStatus(page, 'Active')
  await rows(win).filter({ hasText: 'Beta' }).click()
  await expect(statusPicker(win)).toHaveAttribute('data-value', 'active')

  await pickNoteMore(page, 'Move to Trash')
  await expect(rows(win)).toHaveCount(1)
  await expect(trashRow(win)).toHaveText(/1$/)
})

test('closing a window File > New Window opened saves its edits first', async ({
  page,
  context,
}) => {
  const id = await noteIn(page, 'Plan', 'Start.')
  const win = await openSecondWindow(context)
  await rows(win).filter({ hasText: 'Plan' }).click()
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

test('the first window never answers a window close: Rust hides it or quits', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as { dispatchEvent(e: unknown): void }
    const make = globalThis as unknown as { CustomEvent: new (t: string) => unknown }
    w.dispatchEvent(new make.CustomEvent('devot:note-window-close'))
  })
  await page.waitForTimeout(200)
  expect(await calls(page, 'note_window_close_ready')).toEqual([])
})
