import type { Page } from '@playwright/test'
import { bookPicker, expect, pickStatus, statusPicker, test } from './fixtures'

// The note list's rows and Filter field, and the pickers under the title.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const filter = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const chip = (page: Page) => page.getByRole('button', { name: 'Sort Notes' })
const tagField = (page: Page) => page.getByRole('combobox', { name: 'Add Tag' })

async function createNote(page: Page, title: string, body = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(body)
  }
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a row shows its status as an icon, its task progress and its tags', async ({ page }) => {
  await createNote(page, 'Chores', '- [x] dishes\n- [ ] laundry\n- [ ] bins\n- [ ] floor')
  await pickStatus(page, 'Active')
  await tagField(page).fill('home')
  await tagField(page).press('Enter')
  const row = noteRow(page, 'Chores')
  await expect(row.locator('.row-title')).toHaveCSS('font-size', '13px')
  await expect(row.locator('.row-title')).toHaveCSS('font-weight', '600')
  await expect(row.getByRole('img', { name: 'Active' })).toBeVisible()
  await expect(row.locator('.row-status')).toHaveText('')
  await expect(row.locator('.progress-text')).toHaveText('1 of 4')
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1')
  await expect(row.locator('.chip', { hasText: 'home' })).toHaveCSS('border-top-style', 'solid')
  await expect(row.locator('.row-excerpt')).toHaveCSS('white-space', 'nowrap')
})

test('Return in the Filter field focuses the list; the chip reads Best match', async ({ page }) => {
  await createNote(page, 'Garden plan', 'tomato rows')
  await createNote(page, 'Tax notes', 'receipts')
  await expect(chip(page)).toHaveText('Date Updated ↓')
  await filter(page).fill('garden')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(chip(page)).toHaveText('Best match ↑')
  await expect(page.getByRole('button', { name: 'Clear Search' })).toBeVisible()
  await expect(noteRow(page, 'Garden plan').locator('.row-title mark')).toHaveText('Garden')

  await filter(page).press('Enter')
  await expect(noteRows(page).first()).toBeFocused()

  await filter(page).click()
  await filter(page).press('Escape')
  await expect(filter(page)).toHaveValue('')
  await expect(chip(page)).toHaveText('Date Updated ↓')
})

test('the tag field offers matching tags and a Create row', async ({ page }) => {
  await createNote(page, 'One')
  await tagField(page).fill('work')
  await tagField(page).press('Enter')
  await createNote(page, 'Two')
  await tagField(page).fill('wo')
  const suggestions = page.getByRole('listbox', { name: 'Tag suggestions' })
  await expect(suggestions.getByRole('option')).toHaveText(['work', 'Create \u201cwo\u201d'])
  await tagField(page).press('ArrowDown')
  await tagField(page).press('Enter')
  await expect(page.getByRole('group', { name: 'Tags' }).locator('.chip')).toHaveText(['work'])

  await tagField(page).fill('fresh')
  await tagField(page).press('ArrowUp')
  await tagField(page).press('Enter')
  await expect(page.getByRole('group', { name: 'Tags' }).locator('.chip')).toHaveCount(2)
  await expect(page.getByRole('group', { name: 'Tags' })).toContainText('fresh')

  await tagField(page).fill('gone')
  await tagField(page).press('Escape')
  await expect(tagField(page)).toHaveValue('')
  await expect(suggestions).toHaveCount(0)
})

test('the notebook pop-over searches the tree; the status pop-over shows keys', async ({
  page,
}) => {
  await createBook(page, 'Work')
  await createBook(page, 'Home')
  await createNote(page, 'Plan')
  await bookPicker(page).click()
  const books = page.getByRole('listbox', { name: 'Notebook' })
  await expect(page.getByRole('combobox', { name: 'Search notebooks…' })).toBeFocused()
  await page.keyboard.insertText('wor')
  await expect(books.getByRole('option')).toHaveText(['Work'])
  await page.keyboard.press('Enter')
  await expect(books).toHaveCount(0)
  await expect(bookPicker(page)).toBeFocused()
  await expect(bookPicker(page).locator('.popup-value')).toHaveText('Work')

  await statusPicker(page).click()
  const statuses = page.getByRole('listbox', { name: 'Status' })
  await expect(statuses.getByRole('option')).toHaveText([
    'None⌃⌘1',
    'Active⌃⌘2',
    'On Hold⌃⌘3',
    'Completed⌃⌘4',
    'Dropped⌃⌘5',
  ])
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'dropped')
})
