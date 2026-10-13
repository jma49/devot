import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })

async function createNote(page: Page, title: string, body = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(body)
  }
}

/** Moves the open note to the Trash and waits until the Trash count shows it. */
async function trashOpenNote(page: Page) {
  const before = Number((await trashRow(page).textContent())?.match(/(\d+)$/)?.[1] ?? 0)
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(trashRow(page)).toHaveText(new RegExp(`${before + 1}$`))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('moves a note to the Trash and restores it with its metadata', async ({ page }) => {
  await createNote(page, 'Keeper', '# Body kept')
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' })
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  await expect(trashRow(page)).toHaveText(/1$/)

  await trashRow(page).click()
  await expect(page.locator('.list .headline')).toHaveText('Trash')
  await noteRows(page).filter({ hasText: 'Keeper' }).click()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')
  await expect(page.getByRole('article', { name: 'Preview' }).getByRole('heading')).toHaveText(
    'Body kept',
  )
  await page.getByRole('button', { name: 'Restore' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  await expect(trashRow(page)).toHaveText(/0$/)

  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await noteRows(page).filter({ hasText: 'Keeper' }).click()
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('active')
})

test('Cmd+Delete in the list moves the selected note to the Trash', async ({ page }) => {
  await createNote(page, 'Quick')
  await noteRows(page).filter({ hasText: 'Quick' }).click()
  await page.keyboard.press('Meta+Backspace')
  await expect(noteRows(page)).toHaveCount(0)
  await expect(trashRow(page)).toHaveText(/1$/)
})

test('emptying the Trash asks first; Cancel and Escape keep everything', async ({ page }) => {
  await createNote(page, 'One')
  await trashOpenNote(page)
  await createNote(page, 'Two')
  await trashOpenNote(page)
  await trashRow(page).click()

  await page.getByRole('button', { name: 'Empty Trash' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Permanently delete 2 notes in the Trash?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(2)

  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(2)

  await page.getByRole('button', { name: 'Empty Trash' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  await expect(trashRow(page)).toHaveText(/0$/)
  await expect(page.getByRole('button', { name: 'Empty Trash' })).toBeDisabled()

  // Gone for good, even after a reload.
  await page.reload()
  await expect(trashRow(page)).toHaveText(/0$/)
  await expect(noteRows(page)).toHaveCount(0)
})

test('deletes one note permanently from the Trash', async ({ page }) => {
  await createNote(page, 'Goner')
  await trashOpenNote(page)
  await createNote(page, 'Stays')
  await trashOpenNote(page)
  await trashRow(page).click()
  await noteRows(page).filter({ hasText: 'Goner' }).click()
  await page.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(page.getByRole('dialog')).toContainText('Permanently delete “Goner”?')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveText([/^Stays/])
})
