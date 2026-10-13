import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function freshStart(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

const focusButton = (page: Page) => page.getByRole('button', { name: 'Focus Mode' })

test('the toolbar button enters and leaves focus mode', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  const list = page.getByRole('region', { name: 'Notes' })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Quiet')

  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await focusButton(page).click()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sidebar).toBeHidden()
  await expect(list).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Quiet')

  // The editor keeps a reading width in the middle of a wide window.
  const main = await page.getByRole('main').boundingBox()
  const body = await page.locator('.panes').boundingBox()
  expect(main?.width).toBe(1600)
  expect(body?.width).toBeLessThanOrEqual(740)
  expect(Math.abs((body?.x ?? 0) * 2 + (body?.width ?? 0) - 1600)).toBeLessThanOrEqual(1)

  await focusButton(page).click()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sidebar).toBeVisible()
  await expect(list).toBeVisible()
})

test('Shift+Cmd+D toggles focus mode, and the window remembers it', async ({ page }) => {
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  await expect(focusButton(page)).toHaveAttribute('title', 'Focus Mode (\u21e7\u2318D)')
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeHidden()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeHidden()

  await page.reload()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(sidebar).toBeHidden()

  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeVisible()
  await page.reload()
  await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(sidebar).toBeVisible()
})

for (const keys of ['Meta+Alt+Shift+KeyF', 'Meta+Shift+KeyF']) {
  test(`the search shortcut ${keys} leaves focus mode and focuses the field`, async ({ page }) => {
    await freshStart(page)
    await focusButton(page).click()
    await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeHidden()
    await page.keyboard.press(keys)
    await expect(focusButton(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('navigation', { name: 'Sidebar' })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
  })
}

test('hiding the panes slides them, and Reduce Motion makes it immediate', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  const widthOf = () => sidebar.evaluate((el) => el.getBoundingClientRect().width)
  const full = await widthOf()

  await page.keyboard.press('Meta+Shift+KeyD')
  // Mid-slide the sidebar is narrower than it was and not yet gone.
  await expect.poll(widthOf).toBeLessThan(full)
  await expect(sidebar).toBeHidden()
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(sidebar).toBeVisible()
  await expect.poll(widthOf).toBe(full)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(page.locator('.window')).toHaveAttribute('data-focus', 'true')
  expect(await widthOf()).toBe(0)
  await expect(sidebar).toBeHidden({ timeout: 100 })
})
