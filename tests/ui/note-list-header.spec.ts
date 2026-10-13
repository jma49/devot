import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test } from './fixtures'

// The list's header: the Filter field scoped to the view, the sort chip, and
// what a row shows.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const filter = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const chip = (page: Page) => page.getByRole('button', { name: 'Sort Notes' })

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

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the Filter field sits under the list header; Escape clears it', async ({ page }) => {
  await createNote(page, 'Garden plan', 'tomato rows')
  await createNote(page, 'Tax notes', 'receipts')
  await expect(filter(page)).toHaveAttribute('placeholder', 'Filter')
  expect(await filter(page).evaluate((el) => !!el.closest('.list'))).toBe(true)

  await filter(page).fill('garden')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).first()).toContainText('Garden plan')

  await filter(page).press('Escape')
  await expect(filter(page)).toHaveValue('')
  await expect(noteRows(page)).toHaveCount(2)
})

test('the sort chip shows the order and opens the sort menu', async ({ page }) => {
  await expect(chip(page)).toHaveText('Date Updated ↓')
  await chip(page).click()
  await pickMenuItem(page, 'Title (A to Z)')
  await expect(chip(page)).toHaveText('Title \u2191')
})

test('a row shows its time, then up to two lines of body', async ({ page }) => {
  await createNote(page, 'Garden plan', 'tomato rows and beans')
  const row = noteRows(page).first()
  await expect(row.locator('.row-time')).toHaveText('now')
  await expect(row.locator('.row-time')).toHaveAttribute('title', /20\d\d/)
  await expect(row.locator('.row-excerpt')).toContainText('tomato rows and beans')
})
