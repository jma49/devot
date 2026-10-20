import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const bar = (page: Page) => page.getByRole('search', { name: 'Find in Note' })

async function openFind(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('Meta+f')
  await expect(bar(page)).toBeVisible()
}

test('the find bar fades in and leaves a fading copy when it closes', async ({ page }) => {
  await openFind(page)
  const name = (selector: string) =>
    page.locator(selector).evaluate((el) => getComputedStyle(el).animationName)
  expect(await name('.find-bar')).toBe('bar-in')
  // Read as the copy is put in, in the page: it lives one popover duration, less than a slow round trip.
  await page.evaluate(() => {
    const w = globalThis as unknown as { devotClosing?: string }
    new MutationObserver((_, observer) => {
      const copy = document.querySelector('.find-bar[data-closing]')
      if (!copy) return
      observer.disconnect()
      w.devotClosing = getComputedStyle(copy).animationName
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as unknown as { devotClosing?: string }).devotClosing ?? null,
      ),
    )
    .toBe('bar-out')
  await expect(page.locator('.find-bar')).toHaveCount(0)
})
