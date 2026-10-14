import type { Locator, Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  test,
  type TestWindow,
} from './fixtures'

// The appearance (Settings > Appearance): Light, Dark or Match System, the
// default. A chosen appearance marks the root element (`data-appearance`),
// and the generated tokens switch with it whatever the system shows. The
// setting is stored with the editor settings, so a change in the Settings
// window reaches the main window as `devot:editor-settings-changed`.

/** `color.surface.editor` in each appearance. */
const EDITOR = { light: '#ffffff', dark: '#0a0a0a' } as const

const editorSurface = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-surface-editor').trim(),
  )

const settingsCalls = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((call) => call.cmd === 'editor_settings_set')
      .map((call) => call.args['patch']),
  )

test.describe('with the system in light', () => {
  test.use({ colorScheme: 'light' })

  test('switching to Dark changes the editor surface at once, and back', async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.light)
    await expect(page.locator('html')).not.toHaveAttribute('data-appearance')

    await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.dark)

    await changeEditorSettingsElsewhere(page, { appearance: 'system' })
    await expect(page.locator('html')).not.toHaveAttribute('data-appearance')
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.light)
  })

  test('the Dark card in Settings stores the choice and shows it', async ({ page }) => {
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Appearance' })
    await expect(cards.getByRole('radio', { name: 'Match System' })).toBeChecked()

    await cards.getByText('Dark', { exact: true }).click()
    await expect(cards.getByRole('radio', { name: 'Dark' })).toBeChecked()
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.dark)
    await expect.poll(() => settingsCalls(page)).toEqual([{ appearance: 'dark' }])
  })
})

test.describe('with the system in dark', () => {
  test.use({ colorScheme: 'dark' })

  test('Light keeps the light palette', async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.dark)
    await changeEditorSettingsElsewhere(page, { appearance: 'light' })
    await expect.poll(() => editorSurface(page)).toBe(EDITOR.light)
  })
})

// The theme (Settings > Appearance > Theme): Default, or Ivory, a warm one. A
// chosen theme marks the root element (`data-theme`); the generated tokens
// scope each built-in theme by it, so the surfaces change at once, in both
// appearances, and the choice reaches every window like the appearance does.

/** The editor and the sidebar as painted (`color.surface.*`), per theme and appearance. */
const SURFACES = {
  default: {
    light: { editor: 'rgb(255, 255, 255)', sidebar: 'rgba(243, 244, 246, 0.7)' },
    dark: { editor: 'rgb(10, 10, 10)', sidebar: 'rgba(23, 23, 23, 0.7)' },
  },
  ivory: {
    light: { editor: 'rgb(255, 255, 255)', sidebar: 'rgba(245, 244, 237, 0.7)' },
    dark: { editor: 'rgb(48, 48, 46)', sidebar: 'rgba(31, 30, 29, 0.7)' },
  },
} as const

const background = (element: Locator) =>
  element.evaluate((el) => getComputedStyle(el).backgroundColor)

const shownSurfaces = async (page: Page) => ({
  editor: await background(page.locator('main.content')),
  sidebar: await background(page.getByRole('navigation', { name: 'Sidebar' })),
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`the theme with the system in ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('Ivory changes the editor and the sidebar colours at once, and Default brings them back', async ({
      page,
    }) => {
      await page.goto('/')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')

      await changeEditorSettingsElsewhere(page, { theme: 'ivory' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.ivory[scheme])

      await changeEditorSettingsElsewhere(page, { theme: 'default' })
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])
    })

    test('Ivory follows the chosen appearance, not the system', async ({ page }) => {
      const other = scheme === 'light' ? 'dark' : 'light'
      await page.goto('/')
      await changeEditorSettingsElsewhere(page, { theme: 'ivory', appearance: other })
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.ivory[other])
      await changeEditorSettingsElsewhere(page, { theme: 'ivory', appearance: 'system' })
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.ivory[scheme])
    })
  })
}

test.describe('the Theme choice in Settings', () => {
  test.use({ colorScheme: 'light' })

  test('stores the choice and shows it, with Default chosen at first', async ({ page }) => {
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Theme' })
    await expect(cards.getByRole('radio', { name: 'Default' })).toBeChecked()

    await cards.getByText('Ivory', { exact: true }).click()
    await expect(cards.getByRole('radio', { name: 'Ivory' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--color-surface-sidebar-opaque')
            .trim(),
        ),
      )
      .toBe('#f5f4ed')
    await expect.poll(() => settingsCalls(page)).toEqual([{ theme: 'ivory' }])
  })

  test('turns the system accent option off for Ivory, with a hint, and back on for Default', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const accent = page.getByRole('switch', { name: 'Use the system accent colour' })
    const hint = page.getByText('This theme uses its own accent colour.')
    await expect(accent).toBeEnabled()
    await expect(hint).toHaveCount(0)

    await changeEditorSettingsElsewhere(page, { theme: 'ivory' })
    await expect(accent).toBeDisabled()
    await expect(hint).toBeVisible()

    await changeEditorSettingsElsewhere(page, { theme: 'default' })
    await expect(accent).toBeEnabled()
    await expect(hint).toHaveCount(0)
  })
})
