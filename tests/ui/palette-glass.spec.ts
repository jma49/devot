import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) => palette(page).locator('.palette-field')
const input = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })
const selected = (page: Page) => palette(page).locator('[role="option"][aria-selected="true"]')
const footer = (page: Page) => palette(page).locator('#palette-keys')

async function openPalette(page: Page) {
  await page.keyboard.press('Meta+KeyK')
  await expect(input(page)).toBeFocused()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('Glass', () => {
  test('the palette, its field and its rows are concentric capsules on glass', async ({ page }) => {
    await openPalette(page)
    await expect(palette(page)).toHaveCSS('border-radius', '26px')
    await expect(palette(page)).toHaveCSS('padding', '6px')
    await expect(palette(page)).not.toHaveCSS('backdrop-filter', 'none')
    await expect(paletteField(page)).toHaveCSS('border-radius', '999px')
    await expect(paletteField(page)).toHaveCSS('height', '40px')
    await expect(selected(page)).toHaveCSS('border-radius', '999px')
    await expect(selected(page)).toHaveCSS('height', '38px')

    const outer = await palette(page).boundingBox()
    const row = await selected(page).boundingBox()
    expect(row?.x).toBe((outer?.x ?? 0) + 6)
    expect(row?.width).toBe((outer?.width ?? 0) - 12)
  })

  test('the focused field has an inset accent edge and a halo instead of an outline', async ({
    page,
  }) => {
    await openPalette(page)
    await expect(paletteField(page)).toHaveCSS('outline-style', 'none')
    const shadow = await paletteField(page).evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow).toContain('inset')
    expect(shadow.split(/,\s*(?![^(]*\))/)).toHaveLength(2)
  })

  test('key hints are chips, and the selected row keeps its own while arrowing', async ({
    page,
  }) => {
    await openPalette(page)
    const chip = palette(page).locator('.palette-key').first()
    await expect(chip).toHaveCSS('border-radius', '6px')
    await expect(chip).toHaveCSS('border-top-width', '1px')

    const first = await selected(page).getAttribute('id')
    await page.keyboard.press('ArrowDown')
    await expect(selected(page)).toHaveCount(1)
    expect(await selected(page).getAttribute('id')).not.toBe(first)
    await expect(selected(page)).toHaveCSS('border-radius', '999px')
    await expect(input(page)).toHaveAttribute(
      'aria-activedescendant',
      (await selected(page).getAttribute('id')) ?? '',
    )
    const selectedChip = selected(page).locator('.palette-key')
    await expect(selectedChip).toHaveCSS('background-color', /0\.2\)$/)
  })

  test('nested rows keep their indent', async ({ page }) => {
    await openPalette(page)
    const paddingAt = (depth: number) =>
      selected(page).evaluate((el: HTMLElement, value) => {
        el.style.setProperty('--palette-depth', String(value))
        return Number.parseFloat(getComputedStyle(el).paddingLeft)
      }, depth)
    expect((await paddingAt(2)) - (await paddingAt(0))).toBe(32)
  })

  test('the group heading is a tertiary caption above the sources', async ({ page }) => {
    await openPalette(page)
    const heading = palette(page).locator('.palette-group')
    await expect(heading).toHaveText('Sources')
    await expect(heading).toHaveCSS('font-size', '11px')
  })

  test('the footer names Return, Tab and Escape, and Tab opens the selected source', async ({
    page,
  }) => {
    await openPalette(page)
    const hints = footer(page).locator('.palette-hint')
    await expect(hints).toHaveCount(3)
    await expect(hints.nth(0)).toHaveText(/Open$/)
    await expect(hints.nth(1)).toHaveText(/Open Source$/)
    await expect(hints.nth(2)).toHaveText(/esc\s*Close$/)
    await expect(footer(page).locator('kbd').first()).toHaveCSS('border-radius', '6px')

    await page.keyboard.press('Tab')
    await expect(input(page)).toBeFocused()
    await expect(input(page)).toHaveAttribute('placeholder', 'Search commands...')
  })

  test('inside a source the footer drops Tab, and Escape says it goes back', async ({ page }) => {
    await openPalette(page)
    await page.keyboard.press('Tab')
    const hints = footer(page).locator('.palette-hint')
    await expect(hints).toHaveCount(2)
    await expect(hints.nth(1)).toHaveText(/esc\s*Back$/)
    await page.keyboard.press('Escape')
    await expect(footer(page).locator('.palette-hint')).toHaveCount(3)
    await expect(footer(page).locator('.palette-hint').nth(2)).toHaveText(/esc\s*Close$/)
  })
})

test.describe('Classic', () => {
  test('keeps its panel, square field and rows, and its one footer hint', async ({ page }) => {
    await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
    await openPalette(page)
    await expect(palette(page)).toHaveCSS('border-radius', '8px')
    await expect(palette(page)).toHaveCSS('padding', '8px')
    await expect(palette(page)).toHaveCSS('backdrop-filter', 'none')
    await expect(paletteField(page)).toHaveCSS('border-radius', '7px')
    await expect(paletteField(page)).toHaveCSS('height', '36px')
    await expect(paletteField(page)).toHaveCSS('outline-style', 'solid')
    await expect(selected(page)).toHaveCSS('border-radius', '5px')
    await expect(selected(page)).toHaveCSS('height', '28px')
    await expect(palette(page).locator('.palette-key').first()).toHaveCSS('border-top-width', '0px')
    await expect(palette(page).locator('.palette-group')).toHaveCount(0)
    await expect(footer(page).locator('kbd')).toHaveCount(1)
    await expect(footer(page)).toHaveText(/Open Source$/)
    await expect(footer(page)).not.toContainText('Close')

    await page.keyboard.press('Tab')
    await expect(input(page)).toHaveAttribute(
      'placeholder',
      'Search commands, notebooks, tags, etc...',
    )
  })
})
