import type { Page } from '@playwright/test'
import { expect, pickMenuItem, pickStatus, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const searchField = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const savedRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

async function saveFromField(page: Page, query: string, name: string) {
  await searchField(page).fill(query)
  await page.getByRole('button', { name: 'Search Options' }).click()
  await pickMenuItem(page, 'Save Search\u2026')
  const dialog = page.getByRole('dialog', { name: 'Save Search' })
  await expect(dialog.getByRole('textbox', { name: 'Query' })).toHaveValue(query)
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('saves the query typed, runs it from the sidebar and counts it live', async ({ page }) => {
  await createNote(page, 'Doing')
  await pickStatus(page, 'Active')
  await createNote(page, 'Idle')

  await saveFromField(page, 'status:active', 'In flight')
  await expect(savedRow(page, 'In flight')).toHaveText(/1$/)
  await expect(savedRow(page, 'In flight')).toHaveAttribute('aria-pressed', 'true')

  await searchField(page).press('Escape')
  await expect(savedRow(page, 'In flight')).toHaveAttribute('aria-pressed', 'false')
  await noteRows(page).filter({ hasText: 'Idle' }).click()
  await pickStatus(page, 'Active')
  await expect(savedRow(page, 'In flight')).toHaveText(/2$/)

  await savedRow(page, 'In flight').click()
  await expect(searchField(page)).toHaveValue('status:active')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')).toHaveText(
    'In flight',
  )
})

test('Save Search is in the command palette while a query is typed', async ({ page }) => {
  await createNote(page, 'Garden plan')
  await searchField(page).fill('garden')
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('Save Search')
  await palette.getByRole('option', { name: /Save Search/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Save Search' })
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Garden')
  await dialog.getByRole('button', { name: 'Save' }).click()
  // A query with text is counted only by running it.
  await expect(savedRow(page, 'Garden')).toHaveText('Garden')
})

test('renames, edits and deletes a saved search from its menu', async ({ page }) => {
  await createNote(page, 'Doing')
  await pickStatus(page, 'Active')
  await saveFromField(page, 'status:active', 'Mine')
  await searchField(page).press('Escape')

  await savedRow(page, 'Mine').click({ button: 'right' })
  await pickMenuItem(page, 'Rename')
  const name = sidebar(page).getByRole('textbox', { name: 'Name' })
  await name.fill('Ours')
  await name.press('Enter')
  await expect(savedRow(page, 'Ours')).toBeVisible()

  await savedRow(page, 'Ours').click({ button: 'right' })
  await pickMenuItem(page, 'Edit Saved Search\u2026')
  const edit = page.getByRole('dialog', { name: 'Edit Saved Search' })
  await edit.getByRole('textbox', { name: 'Query' }).fill('status:completed')
  await edit.getByRole('button', { name: 'Save' }).click()
  await expect(savedRow(page, 'Ours')).toHaveText(/0$/)

  await savedRow(page, 'Ours').click({ button: 'right' })
  await pickMenuItem(page, 'Delete Saved Search')
  const confirm = page.getByRole('dialog', { name: /Delete the saved search/ })
  await confirm.getByRole('button', { name: 'Delete Saved Search' }).click()
  await expect(savedRow(page, 'Ours')).toHaveCount(0)
  await expect(sidebar(page).getByText('Saved Searches')).toHaveCount(0)
})

test('a saved search naming a deleted tag stays and matches nothing', async ({ page }) => {
  await createNote(page, 'One')
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill('temp')
  await field.press('Enter')
  await saveFromField(page, 'tag:temp', 'Temp')
  await searchField(page).press('Escape')
  await expect(savedRow(page, 'Temp')).toHaveText(/1$/)

  await sidebar(page)
    .getByRole('button', { name: /^temp 1$/ })
    .focus()
  await page.keyboard.press('Delete')
  await page
    .getByRole('dialog', { name: /Delete the tag/ })
    .getByRole('button', { name: 'Delete Tag' })
    .click()
  await expect(savedRow(page, 'Temp')).toHaveText(/0$/)
  await savedRow(page, 'Temp').click()
  await expect(noteRows(page)).toHaveCount(0)
})

test('reorders saved searches by dragging', async ({ page }) => {
  await createNote(page, 'One')
  await saveFromField(page, 'pinned:true', 'First')
  await saveFromField(page, 'pinned:false', 'Second')
  await searchField(page).press('Escape')
  const rows = page.locator('#searches-list .source-label')
  await expect(rows).toHaveText(['First', 'Second'])

  await savedRow(page, 'Second').dragTo(savedRow(page, 'First'), {
    targetPosition: { x: 10, y: 2 },
  })
  await expect(rows).toHaveText(['Second', 'First'])
})
