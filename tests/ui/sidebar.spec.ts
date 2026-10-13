import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

async function createTag(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await page.getByRole('textbox', { name: 'Title' }).fill('Tagged')
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  await expect(
    sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) }),
  ).toBeVisible()
}

test('lists the sections in order: All Notes, Pinned, Templates, Notebooks, Status, Tags, Trash', async ({
  page,
}) => {
  await createTag(page, 'urgent')
  const order = await sidebar(page).evaluate((nav) =>
    Array.from(nav.querySelectorAll('.source-label, .section-header > span:first-child')).map(
      (el) => el.textContent,
    ),
  )
  const sections = ['All Notes', 'Pinned', 'Templates', 'Notebooks', 'Status']
  expect(order.slice(0, sections.length)).toEqual(sections)
  expect(order.indexOf('Tags')).toBeGreaterThan(order.indexOf('Dropped'))
  expect(order.at(-1)).toBe('Trash')
})

test('the chevron folds Tags, points up while folded, and the choice is kept after a reload', async ({
  page,
}) => {
  await createTag(page, 'urgent')
  const row = sidebar(page).getByRole('button', { name: /^urgent \d+$/ })
  await sidebar(page).getByRole('button', { name: 'Collapse Tags' }).click()
  await expect(row).toHaveCount(0)
  await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await page.reload()
  await expect(sidebar(page).getByRole('button', { name: 'Expand Tags' })).toBeVisible()
  await expect(row).toHaveCount(0)
  await sidebar(page).getByRole('button', { name: 'Expand Tags' }).click()
  await expect(row).toBeVisible()
})

test('the search buttons open the palette scoped to notebooks and to tags', async ({ page }) => {
  await createTag(page, 'urgent')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await sidebar(page).getByRole('button', { name: 'Search Notebooks' }).click()
  await expect(palette.getByRole('combobox')).toHaveAttribute('placeholder', 'Search notebooks...')
  await palette.getByRole('combobox').press('Escape')
  await palette.getByRole('combobox').press('Escape')
  await expect(palette).toHaveCount(0)
  await sidebar(page).getByRole('button', { name: 'Search Tags' }).click()
  await expect(palette.getByRole('combobox')).toHaveAttribute('placeholder', 'Search tags...')
  await expect(palette.locator('#palette-keys')).toContainText('Show Notes with Tag')
})

test('Shift+Cmd+J moves the selection from All Notes to the next row', async ({ page }) => {
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(header(page)).toHaveText('All Notes')
  await page.keyboard.press('Meta+Shift+KeyJ')
  await expect(sidebar(page).getByRole('button', { name: /^Pinned/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('the footer shows when the last note was saved', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Saved')
  await expect(sidebar(page)).toContainText(/Saved at \d\d:\d\d:\d\d/)
  await sidebar(page).getByRole('button', { name: 'Backup and mirror status' }).click()
  await expect(sidebar(page).getByRole('group', { name: 'Backup and mirror status' })).toBeVisible()
})
