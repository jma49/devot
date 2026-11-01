import { changeEditorSettingsElsewhere, expect, openSettings, test } from './fixtures'

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

    test('floats navigation above a shared sheet and restores Classic without losing the pane', async ({
      page,
    }, testInfo) => {
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

      await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
      await expect(nav).toHaveCSS('margin-top', '0px')
      await expect(nav).toHaveCSS('border-radius', '0px')
      await expect(pane).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(page.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      )
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
    for (const transparency of [-100, 0, 100]) {
      await changeEditorSettingsElsewhere(page, { windowTransparency: transparency })
      expect(
        await slider.evaluate((el) => getComputedStyle(el, '::-webkit-slider-thumb').width),
      ).toBe('32px')
      await expect(toggle).toHaveCSS('width', '44px')
      expect(await toggle.evaluate((el) => getComputedStyle(el, '::after').width)).toBe('26px')
      await expect(page.locator('.settings-card').first()).toHaveCSS('border-radius', '18px')
      expect(
        await slider.evaluate((el) =>
          getComputedStyle(el).getPropertyValue('--size-glass-slider-knob-width').trim(),
        ),
      ).toBe('32px')
    }
    await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
    await expect(toggle).toHaveCSS('width', '38px')
    await expect(page.locator('.settings-card').first()).toHaveCSS('border-radius', '12px')
  })
}
