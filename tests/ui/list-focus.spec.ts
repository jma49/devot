// The note list keeps the keyboard when the row that has it leaves the list
// (Move to Trash, Delete Permanently, a move out of the notebook): the next
// row (or the previous one at the end) opens and takes it, or the list itself
// when it is empty.
import type { Page } from '@playwright/test'
import {
  expect,
  pickMenuItem,
  test,
  type TestWindow,
  pickNoteMore,
  openNotePinned,
} from './fixtures'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const noteRows = (page: Page) => list(page).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const pinnedHeader = (page: Page) => list(page).locator('.list-section', { hasText: 'Pinned' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const trashSource = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

/** Three notes, newest first: Gamma, Beta, Alpha. */
async function threeNotes(page: Page) {
  for (const title of ['Alpha', 'Beta', 'Gamma']) await createNote(page, title)
  await expect(noteRows(page)).toHaveText([/^Gamma/, /^Beta/, /^Alpha/])
}

/** Gives the keyboard to a note's row (clicking it also opens the note). */
async function focusRow(page: Page, title: string) {
  await noteRow(page, title).click()
  await expect(noteRow(page, title)).toBeFocused()
  await expect(titleField(page)).toHaveValue(title)
}

/** The row with this title is open (selected), shown in the editor, and has the keyboard. */
async function expectOpenAndFocused(page: Page, title: string) {
  await expect(noteRow(page, title)).toHaveAttribute('aria-selected', 'true')
  await expect(noteRow(page, title)).toBeFocused()
  await expect(titleField(page)).toHaveValue(title)
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

/** Right-clicks a row and waits for its native menu. */
async function openMenu(page: Page, title: string) {
  const before = await popups(page)
  await noteRow(page, title).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

async function trashCount(page: Page, count: number) {
  await expect(trashSource(page)).toHaveText(new RegExp(`${count}$`))
}

/** Moves every note to the Trash with the toolbar button: Alpha, Beta, then Gamma. */
async function trashAll(page: Page) {
  for (const [i, title] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    await noteRow(page, title).click()
    await expect(titleField(page)).toHaveValue(title)
    await pickNoteMore(page, 'Move to Trash')
    await trashCount(page, i + 1)
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Cmd+Delete opens the next row and keeps the keyboard in the list', async ({ page }) => {
  await threeNotes(page)
  await focusRow(page, 'Gamma')
  await page.keyboard.press('Meta+Backspace')
  await trashCount(page, 1)
  await expect(noteRows(page)).toHaveText([/^Beta/, /^Alpha/])
  await expectOpenAndFocused(page, 'Beta')

  // The list's keys still work: arrows move, P pins.
  await page.keyboard.press('ArrowDown')
  await expectOpenAndFocused(page, 'Alpha')
  await page.keyboard.press('KeyP')
  await expect(pinnedHeader(page)).toBeVisible()
  await expect(noteRow(page, 'Alpha')).toBeFocused()
  await expect.poll(() => openNotePinned(page)).toBe(true)
})

test('at the end of the list the previous row takes over; then the list', async ({ page }) => {
  await threeNotes(page)
  await focusRow(page, 'Alpha')
  await page.keyboard.press('Meta+Backspace')
  await trashCount(page, 1)
  await expectOpenAndFocused(page, 'Beta')
  await page.keyboard.press('Meta+Backspace')
  await trashCount(page, 2)
  await expectOpenAndFocused(page, 'Gamma')
  await page.keyboard.press('Meta+Backspace')
  await trashCount(page, 3)
  await expect(noteRows(page)).toHaveCount(0)
  await expect(list(page)).toBeFocused()
  // The empty list's own keys work: / searches the view.
  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
})

test('after Duplicate, Cmd+Delete on the copy leaves the keyboard on a row', async ({ page }) => {
  await threeNotes(page)
  await focusRow(page, 'Beta')
  await page.keyboard.press('Meta+KeyD')
  await expect(noteRow(page, 'Beta')).toHaveCount(2)
  const copy = noteRows(page).and(page.locator('[aria-selected="true"]'))
  await expect(copy).toBeFocused()
  await page.keyboard.press('Meta+Backspace')
  await trashCount(page, 1)
  await expect(noteRows(page)).toHaveCount(3)
  const open = noteRows(page).and(page.locator('[aria-selected="true"]'))
  await expect(open).toHaveCount(1)
  await expect(open).toBeFocused()
  // The keyboard works on the row that took over: M opens the picker for it.
  await page.keyboard.press('KeyM')
  await expect(page.getByRole('dialog', { name: 'Move to Notebook' })).toBeVisible()
})

test('Move to Trash from the menu opens the next row and focuses it', async ({ page }) => {
  await threeNotes(page)
  await focusRow(page, 'Beta')
  await openMenu(page, 'Beta')
  await pickMenuItem(page, 'Move to Trash')
  await trashCount(page, 1)
  await expectOpenAndFocused(page, 'Alpha')
  await page.keyboard.press('ArrowUp')
  await expectOpenAndFocused(page, 'Gamma')
})

test('Move to Trash from the menu on another row keeps the open note focused', async ({ page }) => {
  await threeNotes(page)
  await focusRow(page, 'Gamma')
  await openMenu(page, 'Beta')
  await expect(noteRow(page, 'Beta')).toBeFocused()
  await pickMenuItem(page, 'Move to Trash')
  await trashCount(page, 1)
  await expect(noteRows(page)).toHaveText([/^Gamma/, /^Alpha/])
  await expectOpenAndFocused(page, 'Gamma')
  await page.keyboard.press('ArrowDown')
  await expectOpenAndFocused(page, 'Alpha')
})

test('Delete Permanently in the Trash list opens the next trashed note', async ({ page }) => {
  await threeNotes(page)
  await trashAll(page)
  await trashSource(page).click()
  await expect(page.locator('.list .headline')).toHaveText('Trash')
  await expect(noteRows(page)).toHaveCount(3)
  const second = noteRows(page).nth(1)
  const third = await noteRows(page).nth(2).textContent()
  await second.click()
  await expect(second).toBeFocused()
  await page.keyboard.press('Meta+Backspace')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Permanently delete')
  await dialog.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(2)
  const next = noteRows(page).nth(1)
  await expect(next).toHaveText(third ?? '')
  await expect(next).toHaveAttribute('aria-selected', 'true')
  await expect(next).toBeFocused()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')
  // The Trash list's keys still work on it.
  await page.keyboard.press('Meta+Backspace')
  await expect(page.getByRole('dialog')).toContainText('Permanently delete')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).first()).toBeFocused()
  await page.keyboard.press('Meta+Backspace')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  await expect(list(page)).toBeFocused()
})

test('moving the open note out of the notebook opens the next row', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Work')
  await field.press('Enter')
  await expect(page.getByRole('treeitem', { name: /^Work\b/ })).toBeVisible()
  await threeNotes(page)
  await focusRow(page, 'Beta')
  await page.keyboard.press('KeyM')
  const picker = page.getByRole('dialog', { name: 'Move to Notebook' })
  await expect(picker).toBeVisible()
  await picker.getByRole('option', { name: 'No Notebook' }).click()
  await expect(picker).toHaveCount(0)
  await expect(noteRows(page)).toHaveText([/^Gamma/, /^Alpha/])
  await expectOpenAndFocused(page, 'Alpha')
})

test('Restore from the palette in the Trash list opens the next row', async ({ page }) => {
  await threeNotes(page)
  await trashAll(page)
  await trashSource(page).click()
  await expect(noteRows(page)).toHaveCount(3)
  const first = await noteRows(page).nth(0).textContent()
  const second = await noteRows(page).nth(1).textContent()
  await noteRows(page).nth(0).click()
  await expect(noteRows(page).nth(0)).toBeFocused()
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('restore from trash')
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(
    'Restore from Trash',
  )
  await page.keyboard.press('Enter')
  await trashCount(page, 2)
  await expect(noteRows(page).filter({ hasText: first ?? '' })).toHaveCount(0)
  const next = noteRows(page).first()
  await expect(next).toHaveText(second ?? '')
  await expect(next).toHaveAttribute('aria-selected', 'true')
  await expect(next).toBeFocused()
})

test('a row the filter hides hands the keyboard to the next one', async ({ page }) => {
  await threeNotes(page)
  for (const title of ['Alpha', 'Beta', 'Gamma']) {
    await focusRow(page, title)
    await page.keyboard.press('KeyP')
    await expect(noteRow(page, title)).toBeFocused()
  }
  await sidebar(page)
    .getByRole('button', { name: /^Pinned \d+$/ })
    .click()
  await expect(noteRows(page)).toHaveCount(3)
  const titles = (await noteRows(page).allTextContents()).map(
    (text) => /^(Alpha|Beta|Gamma)/.exec(text)?.[1] ?? '',
  )
  await focusRow(page, titles[1] ?? '')
  // Unpinning takes the note out of the Pinned filter.
  await page.keyboard.press('KeyP')
  await expect(noteRows(page)).toHaveCount(2)
  await expectOpenAndFocused(page, titles[2] ?? '')
})

test('switching views from the keyboard opens no note', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill('Work')
  await field.press('Enter')
  await expect(page.getByRole('treeitem', { name: /^Work\b/ })).toBeVisible()
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await createNote(page, 'Gamma')
  await expect(noteRows(page)).toHaveText([/^Gamma/, /^Beta/, /^Alpha/])
  // Gamma, outside Work, is open and its row has the keyboard.
  await focusRow(page, 'Gamma')
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('work')
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText('Work')
  await page.keyboard.press('Enter')
  await expect(page.locator('.list .headline')).toHaveText('Work')
  await expect(noteRows(page)).toHaveText([/^Beta/, /^Alpha/])
  await expect(list(page).locator('[aria-selected="true"]')).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Gamma')
})
