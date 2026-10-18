import type { Page } from '@playwright/test'
import { clipboardWrites, expect, pickMenuItem, shownMenu, test, type TestWindow } from './fixtures'

// The editor's native menu: a right-click in the text, or Shift+F10 at the
// caret. Cut, Copy, Paste and Select All are the system's own items.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n)
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

/** The menu lines without the accelerators the keys add. */
async function menu(page: Page): Promise<string[]> {
  const lines = await shownMenu(page)
  return lines.map((l) => l.replace(/ (?:Ctrl|Shift|Alt|CmdOrCtrl)(?:\+\S+)+$/, ''))
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

async function newNote(page: Page, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  // Inserted at once, so the editor's bracket helpers do not interfere.
  await page.keyboard.insertText(text)
  await expect(line(page, 0)).toHaveText(text.split('\n')[0] ?? '')
}

/** Selects a whole line's text. */
async function selectLine(page: Page, n: number) {
  await line(page, n).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
}

/** Right-clicks the text in a line and waits for the menu to pop up. */
async function rightClick(page: Page, text: string, n = 0) {
  const before = await popups(page)
  await line(page, n).getByText(text).first().click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

const EDIT_ITEMS = [
  'Undo',
  'Redo',
  '---',
  'Cut',
  'Copy',
  'Paste',
  'Paste as Plain Text',
  'Select All',
  '---',
  'Speech >',
  '  Start Speaking',
  '  Stop Speaking',
]

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a right-click in plain text shows the edit items and Speech', async ({ page }) => {
  await newNote(page, 'plain words')
  await rightClick(page, 'plain')
  expect(await menu(page)).toEqual(EDIT_ITEMS)
})

test('a selection adds Look Up and New Note from Selection', async ({ page }) => {
  await newNote(page, 'first line\nsecond line')
  await selectLine(page, 0)
  await rightClick(page, 'first')
  expect(await menu(page)).toEqual([
    'Look Up “first line”',
    '---',
    'New Note from Selection',
    '---',
    ...EDIT_ITEMS,
  ])
})

test('Look Up asks Rust for the dictionary at the pointer', async ({ page }) => {
  await newNote(page, 'serendipity')
  await selectLine(page, 0)
  await rightClick(page, 'serendipity')
  await pickMenuItem(page, 'Look Up “serendipity”')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as TestWindow).devotIpcCalls.find((c) => c.cmd === 'text_look_up')
            ?.args['text'],
      ),
    )
    .toBe('serendipity')
})

test('Speech starts and stops through Rust', async ({ page }) => {
  await newNote(page, 'read me')
  await selectLine(page, 0)
  await rightClick(page, 'read')
  await pickMenuItem(page, 'Start Speaking', 'Speech')
  await rightClick(page, 'read')
  await pickMenuItem(page, 'Stop Speaking', 'Speech')
  const speech = await page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'text_speak')
      .map((c) => c.args['action']),
  )
  expect(speech).toEqual(['start', 'stop'])
})

test('New Note from Selection in the menu moves the text into a note', async ({ page }) => {
  await newNote(page, 'keep this\nmove this')
  await selectLine(page, 1)
  await rightClick(page, 'move', 1)
  await pickMenuItem(page, 'New Note from Selection')
  await expect(line(page, 1)).toHaveText(/^\[move this\]\(devot:\/\/note\/[0-9a-f-]{36}\)$/)
  await expect(line(page, 0)).toHaveText('keep this')
  await expect(noteRows(page)).toHaveCount(2)
})

test('a right-click away from the selection moves the caret there first', async ({ page }) => {
  await newNote(page, 'keep this\nmove this')
  await selectLine(page, 1)
  await rightClick(page, 'keep', 0)
  // The selection is gone with the caret moved: no Look Up for it.
  expect((await menu(page)).slice(0, 2)).toEqual(['Undo', 'Redo'])
})

test('a link offers Open Link and Copy Link Address', async ({ page }) => {
  await newNote(page, '[site](https://example.com/a)')
  await rightClick(page, 'site')
  const items = await menu(page)
  expect(items.slice(0, 3)).toEqual(['Open Link', 'Copy Link Address', '---'])

  await pickMenuItem(page, 'Copy Link Address')
  await expect.poll(() => clipboardWrites(page)).toEqual(['https://example.com/a'])

  await rightClick(page, 'site')
  await pickMenuItem(page, 'Open Link')
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls))
    .toContainEqual({ cmd: 'open_external', args: { url: 'https://example.com/a' } })
})

test('Shift+F10 opens the menu at the caret, on a link too', async ({ page }) => {
  await newNote(page, '[site](https://example.com/a)')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const before = await popups(page)
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect((await menu(page)).slice(0, 2)).toEqual(['Open Link', 'Copy Link Address'])
  // Nothing was typed, and the menu did not move the caret out of the link.
  await expect(line(page, 0)).toHaveText('[site](https://example.com/a)')
})

test('the Menu key opens it too, without a link in plain text', async ({ page }) => {
  await newNote(page, 'words')
  const before = await popups(page)
  await page.keyboard.press('ContextMenu')
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await menu(page)).toEqual(EDIT_ITEMS)
})
