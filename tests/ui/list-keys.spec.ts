import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const tagField = (page: Page) => page.getByRole('combobox', { name: 'Add Tag' })
const suggestions = (page: Page) =>
  page.getByRole('listbox', { name: 'Tag suggestions' }).getByRole('option')

async function newNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

test('the tag suggestions stop at their ends, Return picks and Escape closes', async ({ page }) => {
  await openApp(page)
  await newNote(page, 'First')
  for (const name of ['alpha', 'alps']) {
    await tagField(page).fill(name)
    await tagField(page).press('Enter')
  }
  await newNote(page, 'Second')
  await tagField(page).fill('al')
  await expect(suggestions(page)).toHaveCount(3)
  const selected = () =>
    suggestions(page).evaluateAll((rows) =>
      rows.findIndex((row) => row.getAttribute('aria-selected') === 'true'),
    )

  await tagField(page).press('ArrowUp')
  await expect.poll(selected).toBe(2)
  await tagField(page).press('ArrowDown')
  await expect.poll(selected).toBe(2)
  await tagField(page).press('ArrowUp')
  await tagField(page).press('ArrowUp')
  await tagField(page).press('ArrowUp')
  await expect.poll(selected).toBe(0)

  await tagField(page).press('Escape')
  await expect(suggestions(page)).toHaveCount(0)
  await tagField(page).fill('al')
  await tagField(page).press('ArrowDown')
  await tagField(page).press('Enter')
  await expect(page.locator('.note-meta .chip', { hasText: 'alpha' })).toHaveCount(1)
})
