import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { openPhoneNote } from './phone'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

async function openNote(page: Page) {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await openPhoneNote(page)
  await expect(page.locator('.phone-note-chips')).toBeVisible()
}

test('the + Tag chip opens the list in a sheet; T does nothing', async ({ page }) => {
  await openNote(page)
  const sheetField = page.getByRole('textbox', { name: 'Tag name' })
  await page.keyboard.press('KeyT')
  await expect(sheetField).toHaveCount(0)

  await page.locator('.phone-note-chips .phone-chip-dashed').click()
  await expect(sheetField).toBeVisible()
  await sheetField.fill('fresh')
  await page.getByRole('radio', { name: 'Green' }).click()
  await page.getByRole('button', { name: /Create/ }).click()
  await expect(page.getByRole('button', { name: 'fresh 1' })).toBeVisible()
  await expect(page.locator('.phone-note-chips .phone-chip[data-tag="green"]')).toHaveCount(1)
})

test('the picker works at 44 point targets', async ({ page }) => {
  await openNote(page)
  await page.locator('.phone-note-chips .phone-chip-dashed').click()
  await page.getByRole('textbox', { name: 'Tag name' }).fill('fresh')
  const swatch = page.getByRole('radio', { name: 'Green' })
  expect((await swatch.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.getByRole('radio', { name: 'Custom Color' }).click()
  const hue = page.getByRole('slider', { name: 'Hue' })
  expect((await hue.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.getByRole('textbox', { name: 'Hex' }).fill('#ff00aa')
  const done = page.getByRole('button', { name: 'Done' })
  expect((await done.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await done.click()
  await page.getByRole('button', { name: /Create/ }).click()
  await expect(page.locator('.phone-note-chips .phone-chip[data-tag="#ff00aa"]')).toHaveCSS(
    'color',
    /.+/,
  )
})
