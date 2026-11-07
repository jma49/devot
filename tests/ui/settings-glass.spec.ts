import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  paintedBackground,
  test,
} from './fixtures'

const appearancePane = (page: Page) => page.getByRole('region', { name: 'Appearance' }).first()
const transparencySlider = (page: Page) =>
  appearancePane(page).getByRole('slider', { name: 'Glass Transparency' })
const materialSlider = (page: Page) =>
  appearancePane(page).getByRole('slider', { name: 'Material Transparency' })
const sliderValue = (page: Page, index: number) => appearancePane(page).locator('output').nth(index)

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => window.devotIpcCalls.filter((call) => call.cmd === c).map((call) => call.args),
    cmd,
  )

test('the transparency adjusts the sheet: opaque at one end, the design in the middle, twice as clear at the other', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window
    w.devotEditorRevision = 2
    w.devotEditorSettings = { windowTransparency: -100 }
  })
  await page.goto('/')
  const list = page.getByRole('region', { name: 'Notes' })
  const editor = page.getByRole('main')
  await expect.poll(() => paintedBackground(list)).toBe('rgb(255, 255, 255)')
  await expect.poll(() => paintedBackground(editor)).toBe('rgb(255, 255, 255)')
  await changeEditorSettingsElsewhere(page, { windowTransparency: 100 })
  await expect.poll(() => paintedBackground(list)).toBe('rgba(255, 255, 255, 0.5)')
  await expect.poll(() => paintedBackground(editor)).toBe('rgba(255, 255, 255, 0.5)')
  await changeEditorSettingsElsewhere(page, { windowTransparency: 0 })
  await expect.poll(() => paintedBackground(list)).toBe('rgba(255, 255, 255, 0.75)')
  await expect.poll(() => paintedBackground(editor)).toBe('rgba(255, 255, 255, 0.75)')
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('the material transparency adjusts the glass and leaves the sheet', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotEditorRevision = 2
    w.devotEditorSettings = { materialTransparency: -100 }
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const sidebar = page.locator('.sidebar')
  const list = page.getByRole('region', { name: 'Notes' })
  await expect.poll(() => paintedBackground(sidebar)).toBe('rgb(255, 255, 255)')
  await expect.poll(() => paintedBackground(list)).toBe('rgba(255, 255, 255, 0.75)')
  await changeEditorSettingsElsewhere(page, { materialTransparency: 100 })
  await expect.poll(() => paintedBackground(sidebar)).toBe('rgba(255, 255, 255, 0.6)')
  await changeEditorSettingsElsewhere(page, { materialTransparency: 0 })
  await expect.poll(() => paintedBackground(sidebar)).toBe('rgba(255, 255, 255, 0.8)')
  await changeEditorSettingsElsewhere(page, { windowTransparency: 100 })
  await expect.poll(() => paintedBackground(sidebar)).toBe('rgba(255, 255, 255, 0.8)')
  await expect.poll(() => paintedBackground(list)).toBe('rgba(255, 255, 255, 0.5)')
})

test('the Settings window adjusts how see-through Glass is with a slider', async ({ page }) => {
  await openSettings(page, 'Appearance')
  await expect(transparencySlider(page)).toHaveValue('0')
  await expect(transparencySlider(page)).toHaveAccessibleDescription(/shows through/)
  await expect(sliderValue(page, 0)).toHaveText('0')

  await transparencySlider(page).fill('40')
  await expect(sliderValue(page, 0)).toHaveText('+40')
  await expect
    .poll(() => calls(page, 'editor_settings_set'))
    .toEqual([{ patch: { windowTransparency: 40 } }])
  await transparencySlider(page).focus()
  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(() => calls(page, 'editor_settings_set'))
    .toEqual([{ patch: { windowTransparency: 40 } }, { patch: { windowTransparency: 35 } }])
})

test('the Settings window adjusts the glass material with its own slider', async ({ page }) => {
  await openSettings(page, 'Appearance')
  await expect(materialSlider(page)).toHaveValue('0')
  await expect(materialSlider(page)).toHaveAccessibleDescription(/shows through/)
  await expect(sliderValue(page, 1)).toHaveText('0')

  await materialSlider(page).fill('-40')
  await expect(sliderValue(page, 1)).toHaveText('-40')
  await expect(sliderValue(page, 0)).toHaveText('0')
  await expect
    .poll(() => calls(page, 'editor_settings_set'))
    .toEqual([{ patch: { materialTransparency: -40 } }])
})

test('an appearance change that cannot be stored is reported and dropped', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = { editor_settings_set: { error: 'E_EDITOR_SETTINGS_WRITE_FAILED' } }
  })
  await openSettings(page, 'Appearance')
  const schemes = page.getByRole('radiogroup', { name: 'Color scheme' })
  await schemes.getByText('Dark', { exact: true }).click()
  await expect(appearancePane(page).getByRole('alert')).toHaveText(
    'The appearance settings could not be saved.',
  )
  await expect(schemes.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked()
})

test('switches the entire palette and selected picture with animations enabled', async ({
  page,
}) => {
  await openSettings(page, 'Appearance')
  await changeEditorSettingsElsewhere(page, { animations: 'always', appearance: 'light' })
  const schemes = page.getByRole('radiogroup', { name: 'Color scheme' })
  const ring = (name: string) =>
    schemes
      .locator('.choice')
      .filter({ has: page.getByRole('radio', { name, exact: true }) })
      .locator('.choice-frame')
      .evaluate((el) => getComputedStyle(el, '::after').borderTopColor)
  for (const choice of ['Dark', 'Light', 'Dark']) {
    await schemes.getByText(choice, { exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-appearance', choice.toLowerCase())
    await expect(page.locator('html')).not.toHaveAttribute('data-appearance-changing')
    await expect.poll(() => ring(choice)).not.toBe('rgba(0, 0, 0, 0)')
    await expect.poll(() => ring(choice === 'Dark' ? 'Light' : 'Dark')).toBe('rgba(0, 0, 0, 0)')
  }
})

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} Settings glass`, () => {
    test.use({ colorScheme, viewport: { width: 900, height: 680 } })

    test('floats navigation above a shared sheet', async ({ page }, testInfo) => {
      await openSettings(page, 'Appearance')
      const nav = page.locator('.settings-nav')
      const pane = page.locator('.settings-pane')
      await expect(nav).toHaveCSS('margin-top', '8px')
      await expect(nav).toHaveCSS('border-radius', '18px')
      await expect(pane).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const frame = await nav.boundingBox()
      expect(frame?.x).toBe(8)
      expect(frame?.y).toBe(8)
      expect(frame?.height).toBe(664)
      await expect(page.locator('.settings-card').first()).toHaveCSS('border-radius', '18px')
      await page.screenshot({ path: testInfo.outputPath(`settings-${colorScheme}.png`) })
    })

    test('uses opaque surfaces when the system requests more contrast', async ({ page }) => {
      await page.emulateMedia({ contrast: 'more' })
      await openSettings(page, 'Appearance')
      const opaque = await page.locator('.settings-main').evaluate((el) => {
        const color = getComputedStyle(el.closest('.settings')!, '::before').backgroundColor
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = color
        context.fillRect(0, 0, 1, 1)
        return context.getImageData(0, 0, 1, 1).data[3]
      })
      expect(opaque).toBe(255)
      await expect(page.locator('.settings-history')).toHaveCSS('backdrop-filter', 'none')
    })
  })
}

for (const appearance of ['light', 'dark'] as const) {
  test(`capsule controls stay opaque at every transparency in ${appearance}`, async ({ page }) => {
    await openSettings(page, 'Appearance')
    await changeEditorSettingsElsewhere(page, { appearance })
    const toggle = page.getByRole('switch', { name: 'Use the System Accent Color' })
    const slider = page.locator('.slider').first()
    // WebKit does not expose the native thumb through getComputedStyle's pseudo argument.
    const thumb = () =>
      toggle.evaluate((el) => {
        const rules = Array.from(document.styleSheets).flatMap((sheet) =>
          Array.from(sheet.cssRules),
        )
        const rule = (selector: string) =>
          rules.find(
            (r): r is CSSStyleRule =>
              r instanceof CSSStyleRule && r.selectorText.replaceAll('"', "'") === selector,
          )!.style.cssText
        const proxy = document.createElement('span')
        proxy.style.cssText = rule('.slider::-webkit-slider-thumb')
        proxy.style.display = 'inline-block'
        el.parentElement!.append(proxy)
        const style = getComputedStyle(proxy)
        const width = style.width
        const height = style.height
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = style.backgroundColor
        context.fillRect(0, 0, 1, 1)
        const alpha = context.getImageData(0, 0, 1, 1).data[3]
        proxy.remove()
        return { width, height, alpha }
      })
    for (const transparency of [-100, 0, 100]) {
      await changeEditorSettingsElsewhere(page, { windowTransparency: transparency })
      expect(await thumb()).toEqual({ width: '32px', height: '22px', alpha: 255 })
      await expect(page.locator('.choice-frame').first()).toHaveCSS('border-radius', '18px')
      await expect(toggle).toHaveCSS('width', '44px')
      expect(await toggle.evaluate((el) => getComputedStyle(el, '::after').width)).toBe('26px')
      await expect(page.locator('.settings-card').first()).toHaveCSS('border-radius', '18px')
      expect(
        await slider.evaluate((el) =>
          getComputedStyle(el).getPropertyValue('--size-glass-slider-knob-width').trim(),
        ),
      ).toBe('32px')
    }
  })
}

test("a switch's knob stays inside its track", async ({ page }) => {
  await openSettings(page, 'Appearance')
  const toggle = page.getByRole('switch').first()
  await expect(toggle).toBeVisible()
  const { track, knob, inset } = await toggle.evaluate((el) => {
    const after = getComputedStyle(el, '::after')
    return {
      track: el.getBoundingClientRect().height,
      knob: Number.parseFloat(after.height),
      inset: Number.parseFloat(after.top),
    }
  })
  expect(knob + 2 * inset).toBeLessThanOrEqual(track)
})

test('a footnote sits close under its card, with its icon on the first line', async ({ page }) => {
  await openSettings(page, 'Appearance')
  const note = page.locator('.settings-footnote').first()
  await expect(note).toBeVisible()
  const { gap, offCentre } = await note.evaluate((el) => {
    const box = (e: Element) => e.getBoundingClientRect()
    const card = el.previousElementSibling!
    const icon = box(el.querySelector('.icon')!)
    const text = box(el.querySelector('span:last-child')!)
    const line = Number.parseFloat(
      getComputedStyle(el.querySelector('span:last-child')!).lineHeight,
    )
    return {
      gap: box(el).top - box(card).bottom,
      offCentre: Math.abs(icon.top + icon.height / 2 - (text.top + line / 2)),
    }
  })
  expect(gap).toBe(8)
  expect(offCentre).toBeLessThanOrEqual(0.5)
})
