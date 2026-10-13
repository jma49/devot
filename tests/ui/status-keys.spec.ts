import type { Page } from '@playwright/test'
import { expect, reloadApp, test, statusPicker } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) =>
  noteRows(page).filter({ has: page.locator('.row-title', { hasText: title }) })
const status = (page: Page) => statusPicker(page)
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

/** The statuses the in-memory store holds, by title (saved state). */
const storedStatus = (page: Page, title: string) =>
  page.evaluate(
    (t) =>
      (
        JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
          title: string
          status: string
        }[]
      ).find((n) => n.title === t)?.status,
    title,
  )

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

// App-level shortcuts read metaKey, so these press Meta (Command), as the
// other window shortcut tests do; Control+Command+digit is not a text key.
const press = (page: Page, digit: number) => page.keyboard.press(`Meta+Control+Digit${digit}`)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('Control+Command+1 to 5 set the open note status', async ({ page }) => {
  await createNote(page, 'Plan')
  const cases: [number, string, string][] = [
    [2, 'active', 'Active'],
    [3, 'on_hold', 'On Hold'],
    [4, 'completed', 'Completed'],
    [5, 'dropped', 'Dropped'],
  ]
  for (const [digit, id, label] of cases) {
    await press(page, digit)
    await expect(status(page)).toHaveAttribute('data-value', id)
    await expect(noteRow(page, 'Plan').locator('.row-status')).toHaveAttribute('aria-label', label)
    await expect.poll(() => storedStatus(page, 'Plan')).toBe(id)
  }
  await press(page, 1)
  await expect(status(page)).toHaveAttribute('data-value', 'none')
  await expect(noteRow(page, 'Plan').locator('.row-status')).toHaveCount(0)
  await expect.poll(() => storedStatus(page, 'Plan')).toBe('none')
})

test('the shortcuts work while typing in the editor and in the title', async ({ page }) => {
  await createNote(page, 'Typing')
  await body(page).click()
  await page.keyboard.insertText('Some text')
  await press(page, 2)
  await expect(status(page)).toHaveAttribute('data-value', 'active')
  // The editor kept its text and the key typed nothing.
  await expect(body(page)).toHaveText('Some text')

  await titleField(page).click()
  await press(page, 4)
  await expect(status(page)).toHaveAttribute('data-value', 'completed')
  await expect(titleField(page)).toHaveValue('Typing')
})

test('they act on the open note only, and not over a sheet', async ({ page }) => {
  await createNote(page, 'First')
  await createNote(page, 'Second')
  await press(page, 3)
  await expect(status(page)).toHaveAttribute('data-value', 'on_hold')
  await expect.poll(() => storedStatus(page, 'Second')).toBe('on_hold')
  expect(await storedStatus(page, 'First')).toBe('none')

  // Move to Notebook (M on the selected row) opens a sheet; keys go to it.
  await noteRow(page, 'Second').click()
  await page.keyboard.press('KeyM')
  await expect(page.getByRole('dialog', { name: 'Move to Notebook' })).toBeVisible()
  await press(page, 5)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Move to Notebook' })).toHaveCount(0)
  await expect(status(page)).toHaveAttribute('data-value', 'on_hold')
  expect(await storedStatus(page, 'Second')).toBe('on_hold')
  // The window hears the keys again, so the one pressed over the sheet was
  // refused rather than missed: the next one sets the status.
  await press(page, 4)
  await expect(status(page)).toHaveAttribute('data-value', 'completed')
  await expect.poll(() => storedStatus(page, 'Second')).toBe('completed')
  expect(await storedStatus(page, 'First')).toBe('none')
})

test('nothing happens with no note open', async ({ page }) => {
  await createNote(page, 'Alone')
  await page.getByRole('button', { name: /^Trash/ }).click()
  await press(page, 2)
  await page.getByRole('button', { name: /^All Notes/ }).click()
  await noteRow(page, 'Alone').click()
  await expect(status(page)).toHaveAttribute('data-value', 'none')
  expect(await storedStatus(page, 'Alone')).toBe('none')
  // The window hears the keys (the check above is not a missed key): with
  // the note open, the same key sets the status.
  await press(page, 2)
  await expect(status(page)).toHaveAttribute('data-value', 'active')
  await expect.poll(() => storedStatus(page, 'Alone')).toBe('active')
})
