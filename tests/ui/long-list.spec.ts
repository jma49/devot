import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { seedNotes } from './renders'

// A long list renders only rows near the visible part; keyboard, selection and assistive tech still see the whole list.

const NOTES = 1000

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const rows = (page: Page) => list(page).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const caption = (page: Page) =>
  page.getByRole('toolbar', { name: 'Toolbar' }).first().locator('.list-count')
const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.locator('.row-title', { hasText: new RegExp(`^${title}$`) }) })

test.beforeEach(async ({ page }) => {
  await seedNotes(page, NOTES)
  await expect(caption(page)).toHaveText('1,000 notes')
  await expect(row(page, 'Note 1')).toBeVisible()
})

test('renders the rows that show, and the rest as the list scrolls', async ({ page }) => {
  expect(await rows(page).count()).toBeLessThan(200)
  await expect(row(page, 'Note 1')).toHaveAttribute('aria-posinset', '1')
  await expect(row(page, 'Note 1')).toHaveAttribute('aria-setsize', String(NOTES))

  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(row(page, `Note ${NOTES}`)).toBeVisible()
  // Rows far above are not rendered; the first stays, as the row that takes Tab.
  await expect(row(page, 'Note 50')).toHaveCount(0)
  await expect(row(page, 'Note 1')).toHaveAttribute('tabindex', '0')
  expect(await rows(page).count()).toBeLessThan(200)
  await row(page, `Note ${NOTES}`).click()
  await expect(titleField(page)).toHaveValue(`Note ${NOTES}`)
})

test('a long list back from an empty search shows its top again', async ({ page }) => {
  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(row(page, `Note ${NOTES}`)).toBeVisible()
  await row(page, `Note ${NOTES}`).click()
  await expect(titleField(page)).toHaveValue(`Note ${NOTES}`)
  // A short view with no rows: the list's scroll goes to 0 while its last top is kept.
  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.fill('zzzz no such note')
  await expect(page.getByText('No Matching Notes')).toBeVisible()
  await search.fill('')
  await expect(caption(page)).toHaveText('1,000 notes')
  // Not a blank spacer over the kept row: the list is back at its top.
  await expect(row(page, 'Note 1')).toBeVisible()
})

test('the arrow keys walk past the rows first rendered', async ({ page }) => {
  await row(page, 'Note 1').click()
  await expect(row(page, 'Note 1')).toBeFocused()
  for (let i = 0; i < 80; i += 1) await page.keyboard.press('ArrowDown')
  await expect(titleField(page)).toHaveValue('Note 81')
  await expect(row(page, 'Note 81')).toBeFocused()
  await expect(row(page, 'Note 81')).toBeInViewport()
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowUp')
  await expect(titleField(page)).toHaveValue('Note 76')
  await expect(row(page, 'Note 76')).toBeFocused()
})

test('the open note keeps its row and the keyboard when the list scrolls away', async ({
  page,
}) => {
  await row(page, 'Note 2').click()
  await expect(row(page, 'Note 2')).toBeFocused()
  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(row(page, `Note ${NOTES}`)).toBeVisible()
  // Still rendered and focused, though far above the part that shows.
  await expect(row(page, 'Note 2')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(titleField(page)).toHaveValue('Note 3')
  await expect(row(page, 'Note 3')).toBeFocused()
  await expect(row(page, 'Note 3')).toBeInViewport()
})

test('a new note opened elsewhere is scrolled to and takes the keyboard in the list', async ({
  page,
}) => {
  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await row(page, `Note ${NOTES}`).click()
  await expect(row(page, `Note ${NOTES}`)).toBeFocused()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(caption(page)).toHaveText('1,001 notes')
  const created = rows(page).and(page.locator('[aria-selected="true"]'))
  await expect(created.locator('.row-headline')).toHaveText('Untitled')
  await expect(created).toBeInViewport()
})

test('Select All and Shift+Down select across the whole list', async ({ page }) => {
  await row(page, 'Note 1').click()
  await page.keyboard.press('Meta+KeyA')
  await expect(page.getByRole('region', { name: 'Selected Notes' })).toContainText(
    '1,000 Notes Selected',
  )
  await page.keyboard.press('Escape')
  for (let i = 0; i < 60; i += 1) await page.keyboard.press('Shift+ArrowDown')
  await expect(page.getByRole('region', { name: 'Selected Notes' })).toContainText(
    '61 Notes Selected',
  )
  await expect(row(page, 'Note 61')).toBeFocused()
  await expect(row(page, 'Note 61')).toHaveAttribute('aria-selected', 'true')
})
