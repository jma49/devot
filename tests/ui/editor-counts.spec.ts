import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const counts = (page: Page) => page.locator('.editor-counts')

test('the footer counts the note and the selection once typing pauses', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.type('one two **three**')
  await expect(counts(page)).toHaveText('Words 3Characters 11')
  await page.keyboard.press('Shift+Home')
  await expect(counts(page)).toHaveText('Words 3 of 3Characters 11 of 11')
  await page.keyboard.press('End')
  await page.keyboard.type(' four')
  await expect(counts(page)).toHaveText('Words 4Characters 15')
})
