import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const library = (page: Page) => page.getByRole('region', { name: 'Library' })
const tile = (page: Page, name: string) => library(page).getByRole('button', { name })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await expect(library(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`shows the smart tiles, notebooks, Templates and Trash, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    for (const name of ['All Notes', 'Pinned', 'Active', 'Done', 'Templates', 'Trash'])
      await expect(tile(page, name).first()).toBeVisible()
    await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
    const box = await tile(page, 'All Notes').boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(98)
    await expect(library(page).getByText(/^\d+ notes/)).toBeVisible()
  })
}

test('draws row icons without a tile, in the text colour', async ({ page }) => {
  const icon = library(page).locator('.phone-row-icon').first()
  await expect(icon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const [iconColor, textColor] = await Promise.all([
    icon.evaluate((el) => getComputedStyle(el).color),
    library(page).evaluate((el) => getComputedStyle(el).color),
  ])
  expect(iconColor).toBe(textColor)
})

test('counts every note on the All tile', async ({ page }) => {
  const count = library(page).locator('.phone-smart-tile-count').first()
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(0)
  const shown = await count.textContent()
  await expect(library(page).getByText(`${shown} notes`, { exact: false })).toBeVisible()
})

test('a smart tile opens the Notes tab', async ({ page }) => {
  await tile(page, 'Done').click()
  const tabs = page.getByRole('navigation', { name: 'Tabs' })
  await expect(tabs.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'page')
})

test('a notebook opens its list, and the back button returns', async ({ page }) => {
  const row = library(page).locator('.phone-grouped-open').first()
  const name = (await row.locator('.phone-grouped-label').textContent())!
  await row.click()
  await expect(page.getByRole('region', { name })).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(library(page)).toBeVisible()
})

test('the new-notebook button adds a notebook', async ({ page }) => {
  // The button does nothing until the core has started, which the first notebook shows.
  await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
  const added = library(page).locator('.phone-grouped-open').filter({ hasText: 'New Notebook' })
  await expect(added).toHaveCount(0)
  await library(page).getByRole('button', { name: 'New Notebook', exact: true }).click()
  await expect(added).toHaveCount(1)
})

test('every button in the Library is at least 44 points', async ({ page }) => {
  for (const button of await library(page).getByRole('button').all()) {
    const box = await button.boundingBox()
    if (!box) continue
    expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(44)
    expect(box.width, await button.innerText()).toBeGreaterThanOrEqual(44)
  }
})
