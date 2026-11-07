import type { Locator, Page } from '@playwright/test'
import { bookPicker, expect, statusPicker, test } from './fixtures'

async function start(page: Page, path = '/') {
  await page.addInitScript(() => {
    const w = window
    w.devotInitialEditorSettings = { revision: 0, settings: {} }
    w.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
  })
  await page.goto(path)
}

async function newNote(page: Page) {
  await start(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(statusPicker(page)).toBeVisible()
}

async function settled(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
}

async function openBookPicker(page: Page) {
  await newNote(page)
  await bookPicker(page).click()
  const panel = page.locator('.picker-popover:not([data-closing])')
  await settled(panel)
  return panel
}

async function openMoreMenu(page: Page) {
  await start(page, '/settings.html')
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).click()
  await page.getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu', { name: 'More' })
  await expect(menu).toBeVisible()
  return menu
}

async function openTip(page: Page) {
  await start(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.locator('button[title*="("]:visible').first().hover()
  const tip = page.getByRole('tooltip')
  await settled(tip)
  return tip
}

const height = async (locator: Locator) => (await locator.boundingBox())?.height
const before = (locator: Locator, property: string) =>
  locator.evaluate((el, name) => getComputedStyle(el, '::before').getPropertyValue(name), property)

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} floating surfaces`, () => {
    test.use({ colorScheme, viewport: { width: 1100, height: 720 } })

    test('a picker has concentric corners, a tall search field, washed rows and a notch at its button', async ({
      page,
    }) => {
      const panel = await openBookPicker(page)
      await expect(panel).toHaveCSS('border-radius', '18px')
      await expect(panel).toHaveCSS('padding', '6px')
      expect(await panel.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none')

      const field = panel.locator('.picker-search')
      await expect(field).toHaveCSS('border-radius', '12px')
      expect(await height(field)).toBe(32)
      await expect(panel.locator('.picker-search-icon')).toBeVisible()

      const row = panel.getByRole('option').first()
      await expect(row).toHaveCSS('border-radius', '12px')
      expect(await height(row)).toBe(32)

      const selected = panel.locator('.picker-option[aria-selected="true"]')
      const wash = await selected.evaluate((node) => getComputedStyle(node).backgroundColor)
      expect(wash).not.toBe('rgba(0, 0, 0, 0)')
      expect(wash).toMatch(/0\.2\)$/)

      const picker = (await bookPicker(page).boundingBox())!
      const box = (await panel.boundingBox())!
      expect(await before(panel, 'display')).toBe('block')
      const left = Number.parseFloat(await before(panel, 'left'))
      const width = Number.parseFloat(await before(panel, 'width'))
      const tip = box.x + left + width / 2
      expect(tip).toBeGreaterThanOrEqual(picker.x)
      expect(tip).toBeLessThanOrEqual(picker.x + picker.width)
      expect(box.y).toBeGreaterThanOrEqual(picker.y + picker.height + 8)
      await expect(panel).toHaveCSS('overflow-y', 'visible')
      await expect(panel.locator('.picker-list')).toHaveCSS('overflow-y', 'auto')
    })

    test('a page-drawn menu follows the popover radii', async ({ page }) => {
      const menu = await openMoreMenu(page)
      await expect(menu).toHaveCSS('border-radius', '18px')
      await expect(menu).toHaveCSS('padding', '6px')
      const item = menu.getByRole('menuitem').first()
      await expect(item).toHaveCSS('border-radius', '12px')
      expect(await height(item)).toBe(32)
    })

    test('a tooltip is a glass capsule with the key in a chip', async ({ page }) => {
      const tip = await openTip(page)
      await expect(tip).toHaveCSS('border-radius', '12px')
      await expect(tip).toHaveCSS('flex-direction', 'row')
      expect(await tip.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none')
      expect(await before(tip, 'display')).toBe('none')
      await expect(tip.locator('.tool-tip-key')).toHaveCSS('border-radius', '6px')
    })
  })
}
