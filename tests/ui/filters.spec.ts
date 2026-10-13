import type { Page } from '@playwright/test'
import { light } from '../../src/renderer/src/theme/tokens'
import { expect, test, pickNoteMore, openNotePinned, pickStatus, statusPicker } from './fixtures'

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const filter = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

/** Adds a tag by typing it; `shown` is the chip text when an existing tag is reused. */
async function addTag(page: Page, name: string, shown = name) {
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  // A chip, not the suggestions' closing copy that fades out beside them.
  await expect(
    page
      .getByRole('group', { name: 'Tags' })
      .locator('.chip')
      .filter({ hasText: new RegExp(`^${shown}$`) }),
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('sets a status and filters by it, with counts', async ({ page }) => {
  await createNote(page, 'Doing')
  await pickStatus(page, 'Active')
  await createNote(page, 'Idle')
  await expect(filter(page, 'Active')).toHaveText(/1$/)

  await filter(page, 'Active').click()
  await expect(filter(page, 'Active')).toHaveAttribute('aria-pressed', 'true')
  await expect(header(page)).toHaveText('Active')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).first()).toContainText('Doing')

  // Pressing it again clears the filter.
  await filter(page, 'Active').click()
  await expect(noteRows(page)).toHaveCount(2)
})

test('tags a note, reuses tags, filters and removes them', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'sync')
  await createNote(page, 'Two')
  await addTag(page, 'Sync', 'sync')
  await expect(sidebar(page).getByRole('button', { name: /^sync 2$/ })).toBeVisible()
  await expect(noteRows(page).filter({ hasText: 'One' })).toContainText('sync')

  await sidebar(page)
    .getByRole('button', { name: /^sync 2$/ })
    .click()
  await expect(noteRows(page)).toHaveCount(2)

  await page.getByRole('button', { name: 'Remove Tag sync' }).click()
  await expect(sidebar(page).getByRole('button', { name: /^sync 1$/ })).toBeVisible()
  await expect(noteRows(page)).toHaveCount(1)
})

test('deleting a tag removes it from every note', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'temp')
  const tagRow = sidebar(page).getByRole('button', { name: /^temp 1$/ })
  await tagRow.focus()
  await page.keyboard.press('Delete')
  // It asks first.
  const confirm = page.getByRole('dialog', { name: 'Delete the tag \u201ctemp\u201d?' })
  await expect(confirm).toContainText('It will be removed from 1 note.')
  await confirm.getByRole('button', { name: 'Delete Tag' }).click()
  await expect(sidebar(page).getByRole('button', { name: /^temp/ })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Tags' })).not.toContainText('temp')
})

test('declining a tag delete keeps the tag and returns focus to its row', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'keep')
  const tagRow = sidebar(page).getByRole('button', { name: /^keep 1$/ })
  await tagRow.focus()
  await page.keyboard.press('Delete')
  const confirm = page.getByRole('dialog', { name: 'Delete the tag “keep”?' })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(tagRow).toBeFocused()

  // Cancel does the same.
  await page.keyboard.press('Backspace')
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(tagRow).toBeFocused()
})

test('pinned notes sit in their own section at the top', async ({ page }) => {
  await createNote(page, 'Old')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
  await createNote(page, 'New')

  const list = page.getByRole('listbox', { name: 'Notes' })
  await expect(list.locator('.list-section')).toHaveText(['Pinned', 'Notes'])
  await expect(noteRows(page)).toHaveText([/^Old/, /^New/])
  await expect(filter(page, 'Pinned')).toHaveText(/1$/)

  await filter(page, 'Pinned').click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(list.locator('.list-section')).toHaveCount(0)
})

test('filters combine with the selected notebook', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await page.getByRole('textbox', { name: 'Notebook name' }).fill('Work')
  await page.getByRole('textbox', { name: 'Notebook name' }).press('Enter')
  await createNote(page, 'Work active')
  await pickStatus(page, 'Active')
  await page.getByRole('button', { name: /^All Notes/ }).click()
  await createNote(page, 'Loose active')
  await pickStatus(page, 'Active')

  await filter(page, 'Active').click()
  await expect(noteRows(page)).toHaveCount(2)
  await page.getByRole('treeitem', { name: /^Work/ }).locator('> .book-row').click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(header(page)).toHaveText('Active')
  await expect(page.locator('.list .caption')).toHaveText('Work · 1 note')
})

test('status, tags and pinning survive a reload', async ({ page }) => {
  await createNote(page, 'Kept')
  await pickStatus(page, 'On Hold')
  await addTag(page, 'later')
  await pickNoteMore(page, 'Pin to Top')
  await page.reload()
  await noteRows(page).first().click()
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'on_hold')
  await expect(page.getByRole('group', { name: 'Tags' })).toContainText('later')
  await expect.poll(() => openNotePinned(page)).toBe(true)
})

test('the count on a selected filter row stays a number while the sidebar has the keyboard', async ({
  page,
}) => {
  await createNote(page, 'Doing')
  await pickStatus(page, 'Active')
  await filter(page, 'Active').click()
  await expect(filter(page, 'Active')).toHaveAttribute('aria-pressed', 'true')
  // A click does not focus a button in every browser: the keyboard goes to the row.
  await filter(page, 'Active').focus()

  const count = filter(page, 'Active').locator('.source-count')
  await expect(count).toHaveText('1')
  // While the sidebar has the keyboard the selected row is the accent fill:
  // the count takes the on-fill colour and no background, and the icon keeps
  // its mask fill.
  await expect(count).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(count).toHaveCSS('color', rgb(light['color.accent.on-fill']))
  await expect(filter(page, 'Active').locator('.icon')).not.toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
})
