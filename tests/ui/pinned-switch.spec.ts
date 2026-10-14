import type { Page } from '@playwright/test'
import { expect, test, pickNoteMore, openNotePinned } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const source = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await createNote(page, 'Kept')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
  await createNote(page, 'Plain')
})

test('All Notes after Pinned shows every note again, selected', async ({ page }) => {
  await source(page, 'Pinned').click()
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'true')
  await expect(noteRows(page)).toHaveCount(1)

  await source(page, 'All Notes').click()
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'false')
  await expect(source(page, 'All Notes')).toHaveAttribute('aria-current', 'true')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
})

test('Templates after Pinned, then All Notes, shows every note', async ({ page }) => {
  await source(page, 'Pinned').click()
  await sidebar(page)
    .getByRole('button', { name: /^Templates/ })
    .click()
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'false')
  await source(page, 'All Notes').click()
  await expect(source(page, 'All Notes')).toHaveAttribute('aria-current', 'true')
  await expect(noteRows(page)).toHaveCount(2)
})

test('All Notes after Pinned, from inside a notebook, leaves both', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await page.keyboard.press('Enter')
  await source(page, 'Pinned').click()
  await source(page, 'All Notes').click()
  await expect(noteRows(page)).toHaveCount(2)
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'false')
})
