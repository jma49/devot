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

test('the footer keeps the bottom-right corner of the content column in every layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.type('one two three')
  await expect(counts(page)).toHaveText('Words 3Characters 11')
  const inset = () =>
    page.evaluate(() => {
      const content = document.querySelector('.content')!.getBoundingClientRect()
      const text = document.querySelector('.editor-counts > :last-child')!.getBoundingClientRect()
      const margin = getComputedStyle(document.documentElement).getPropertyValue('--space-10')
      return content.right - text.right - parseFloat(margin)
    })
  const mode = (name: string) =>
    page.locator('.editor-toolbar').getByRole('button', { name, exact: true }).click()

  await expect.poll(inset).toBe(0)
  await mode('Split')
  await expect.poll(inset).toBe(0)
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect.poll(inset).toBe(0)
  await page.getByRole('button', { name: 'Show Sidebar' }).click()
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(page.locator('.window')).toHaveAttribute('data-focus', 'true')
  await expect.poll(inset).toBe(0)
  await mode('Edit')
  await expect.poll(inset).toBe(0)
})
