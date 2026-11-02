import type { Locator, Page } from '@playwright/test'
import { bookPicker, expect, statusPicker, test, type TestWindow } from './fixtures'

async function start(page: Page, glass: boolean, path = '/') {
  await page.addInitScript((sidebarMaterial) => {
    const w = globalThis as unknown as TestWindow & { devotInitialEditorSettings: unknown }
    w.devotInitialEditorSettings = { revision: 0, settings: { sidebarMaterial } }
    w.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
  }, glass)
  await page.goto(path)
}

async function newNote(page: Page, glass: boolean) {
  await start(page, glass)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(statusPicker(page)).toBeVisible()
}

async function settled(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
}

async function openBookPicker(page: Page, glass: boolean) {
  await newNote(page, glass)
  await bookPicker(page).click()
  const panel = page.locator('.picker-popover:not([data-closing])')
  await settled(panel)
  return panel
}

async function openMoreMenu(page: Page, glass: boolean) {
  await start(page, glass, '/settings.html')
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).click()
  await page.getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu', { name: 'More' })
  await expect(menu).toBeVisible()
  return menu
}

async function openTip(page: Page, glass: boolean) {
  await start(page, glass)
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
  test.describe(`${colorScheme} Glass floating surfaces`, () => {
    test.use({ colorScheme, viewport: { width: 1100, height: 720 } })

    test('a picker has concentric corners, a tall search field and rows', async ({ page }) => {
      const panel = await openBookPicker(page, true)
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
    })

    test('the keyboard row and the row under the pointer take the accent wash', async ({
      page,
    }) => {
      const panel = await openBookPicker(page, true)
      const selected = panel.locator('.picker-option[aria-selected="true"]')
      const tint = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor)
      const wash = await tint(selected)
      expect(wash).not.toBe('rgba(0, 0, 0, 0)')
      expect(wash).toMatch(/0\.2\)$/)
    })

    test('a picker points a notch at its button and scrolls inside', async ({ page }) => {
      const panel = await openBookPicker(page, true)
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
      const menu = await openMoreMenu(page, true)
      await expect(menu).toHaveCSS('border-radius', '18px')
      await expect(menu).toHaveCSS('padding', '6px')
      const item = menu.getByRole('menuitem').first()
      await expect(item).toHaveCSS('border-radius', '12px')
      expect(await height(item)).toBe(32)
    })

    test('a tooltip is a glass capsule with the key in a chip', async ({ page }) => {
      const tip = await openTip(page, true)
      await expect(tip).toHaveCSS('border-radius', '12px')
      await expect(tip).toHaveCSS('flex-direction', 'row')
      expect(await tip.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none')
      expect(await before(tip, 'display')).toBe('none')
      await expect(tip.locator('.tool-tip-key')).toHaveCSS('border-radius', '6px')
    })
  })
}

test.describe('Classic floating surfaces stay as they were', () => {
  test.use({ colorScheme: 'light', viewport: { width: 1100, height: 720 } })

  test('a picker', async ({ page }) => {
    const panel = await openBookPicker(page, false)
    await expect(panel).toHaveCSS('border-radius', '8px')
    await expect(panel).toHaveCSS('padding', '4px')
    await expect(panel).toHaveCSS('overflow-y', 'auto')
    expect(await before(panel, 'content')).toBe('none')
    const field = panel.locator('.picker-search')
    await expect(field).toHaveCSS('border-radius', '5px')
    expect(await height(field)).toBe(22)
    await expect(panel.locator('.picker-search-icon')).toBeHidden()
    const row = panel.getByRole('option').first()
    await expect(row).toHaveCSS('border-radius', '6px')
    expect(await height(row)).toBe(24)
  })

  test('a page-drawn menu', async ({ page }) => {
    const menu = await openMoreMenu(page, false)
    await expect(menu).not.toHaveCSS('border-radius', '18px')
    await expect(menu).toHaveCSS('padding', '4px')
    await expect(menu.getByRole('menuitem').first()).not.toHaveCSS('border-radius', '12px')
  })

  test('a tooltip', async ({ page }) => {
    const tip = await openTip(page, false)
    await expect(tip).toHaveCSS('border-radius', '6px')
    await expect(tip).toHaveCSS('flex-direction', 'column')
    expect(await before(tip, 'content')).not.toBe('none')
    await expect(tip.locator('.tool-tip-key')).toHaveCSS('border-radius', '5px')
  })
})
