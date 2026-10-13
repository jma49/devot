import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Every way of changing the view follows the same rules (the sidebar, the
// palette, New Notebook, a finished import): a note in the Trash closes when
// the view leaves the Trash, a search over every note hides its view, and
// Templates behaves like any other list. Window shortcuts are pressed with
// Meta, as the app's registry takes it on every platform.

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

/** Opens the palette with Cmd+P, types a query and picks the entry of a group. */
async function pick(page: Page, query: string, group: string) {
  await page.keyboard.press('Meta+KeyP')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill(query)
  await palette(page)
    .getByRole('group', { name: group })
    .getByRole('option', { name: query, exact: true })
    .click()
  await expect(palette(page)).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('New Notebook from the Trash closes the trashed note instead of editing it', async ({
  page,
}) => {
  await createNote(page, 'Doomed')
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(trashRow(page)).toHaveText(/1$/)
  await trashRow(page).click()
  await noteRow(page, 'Doomed').click()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')

  await createBook(page, 'Fresh')
  await expect(header(page)).toHaveText('Fresh')
  await expect(book(page, 'Fresh')).toHaveAttribute('aria-selected', 'true')
  // The trashed note is not an editor in the new notebook.
  await expect(titleField(page)).toHaveCount(0)
  await expect(body(page)).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(0)
})

test('a notebook from the palette, during a search over every note, drops the hidden filter', async ({
  page,
}) => {
  await createBook(page, 'Work')
  await createNote(page, 'Work plan')
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' })
  const active = sidebar(page).getByRole('button', { name: /^Active \d+$/ })
  await active.click()
  await expect(header(page)).toHaveText('Active')

  // The field searches every note: the filter no longer looks pressed.
  await search(page).click()
  await page.keyboard.type('plan')
  await expect(active).toHaveAttribute('aria-pressed', 'false')

  // As a click on the notebook does: the notebook alone, no filter.
  await pick(page, 'Work', 'Notebooks')
  await expect(header(page)).toHaveText('Work')
  await expect(search(page)).toHaveValue('')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(active).toHaveAttribute('aria-pressed', 'false')
  await expect(noteRows(page)).toHaveCount(1)
})

test('a tag from the palette, during a search over every note, drops the hidden notebook', async ({
  page,
}) => {
  await createNote(page, 'Loose plan')
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('urgent')
  await tagField.press('Enter')
  await expect(page.getByRole('group', { name: 'Tags' }).getByText('urgent')).toBeVisible()
  await createBook(page, 'Work')
  await createNote(page, 'Work plan')

  await search(page).click()
  await page.keyboard.type('plan')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')

  // As a click on the tag does: the tag covers every note.
  await pick(page, 'urgent', 'Tags')
  await expect(header(page)).toHaveText('urgent')
  await expect(search(page)).toHaveValue('')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')
  await expect(noteRows(page)).toHaveText([/Loose plan/])
})
