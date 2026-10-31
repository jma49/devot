import type { Page } from '@playwright/test'
import { expect, pickMenuItem, test } from './fixtures'

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

test('a row shows its time, then one line of body', async ({ page }) => {
  await createNote(page, 'Garden plan', 'tomato rows and beans')
  const row = noteRows(page).first()
  await expect(row.locator('.row-time')).toHaveText('Just now')
  await expect(row.locator('.row-time')).toHaveAttribute('title', /20\d\d/)
  await expect(row.locator('.row-excerpt')).toContainText('tomato rows and beans')
})

test('a row keeps its tag chips on one meta line; the activity strip goes first', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await createNote(page, 'Data Structures and Algorithms', '- [x] one\n- [ ] two\n- [ ] three')
  for (const tag of ['cs', 'algo', 'work']) {
    const add = page.getByRole('combobox', { name: 'Add Tag' })
    await add.fill(tag)
    await add.press('Enter')
  }
  const row = noteRows(page).first()
  const meta = row.locator('.row-meta-items')
  await expect(meta.locator('.chip')).toHaveCount(3)
  await expect(meta.locator('.row-progress')).toBeVisible()
  await expect(meta.locator('.activity-strip')).toHaveCount(1)
  const line = (await meta.boundingBox())!
  const shown = (selector: string) =>
    meta
      .locator(selector)
      .evaluateAll(
        (els, top) =>
          els.map(
            (el) =>
              (
                el as unknown as { getBoundingClientRect(): { top: number } }
              ).getBoundingClientRect().top < top,
          ),
        line.y + line.height,
      )
  expect(await shown('.chip')).toEqual([true, true, true])
  expect(await shown('.activity-strip')).toEqual([false])
  expect(line.height).toBeLessThan(20)
})
