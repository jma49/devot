import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  paintedBackground,
  test,
  type TestWindow,
} from './fixtures'

// A chosen appearance marks the root (`data-appearance`) and the generated tokens switch with it whatever the system
// shows. Stored with the editor settings, so a Settings window change arrives as `devot:editor-settings-changed`.

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

// A chosen theme marks the root (`data-theme`); the generated tokens scope each built-in theme by it, in both
// appearances, and the choice reaches every window like the appearance does.

/** The editor pane and sidebar as painted over the window material, per theme and appearance. */
const SURFACES = {
  default: {
    light: { editor: 'rgba(255, 255, 255, 0.7)', sidebar: 'rgba(255, 255, 255, 0.02)' },
    dark: { editor: 'rgba(10, 10, 10, 0.6)', sidebar: 'rgba(0, 0, 0, 0.1)' },
  },
  ivory: {
    light: { editor: 'rgba(255, 255, 255, 0.7)', sidebar: 'rgba(245, 244, 237, 0.02)' },
    dark: { editor: 'rgba(48, 48, 46, 0.6)', sidebar: 'rgba(31, 30, 29, 0.1)' },
  },
} as const

const background = paintedBackground

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

  test('hides the system accent option for Ivory and shows it again for Default', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const accent = page.getByRole('switch', { name: 'Use the system accent colour' })
    await expect(accent).toBeEnabled()

    await changeEditorSettingsElsewhere(page, { theme: 'ivory' })
    await expect(accent).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Accent colour' })).toHaveCount(0)

    await changeEditorSettingsElsewhere(page, { theme: 'default' })
    await expect(accent).toBeEnabled()
  })
})

test('the Animations choice reduces motion always, as the system asks, or never', async ({
  page,
}) => {
  // The suite's system asks for Reduce Motion (playwright.config.ts).
  await openSettings(page, 'Appearance')
  const root = page.locator('html')
  const choice = page.getByRole('combobox', { name: 'Animations' })
  // The suite's windows follow the system (fixtures.ts); a new install animates always.
  await expect(choice).toHaveValue('system')
  await expect(root).toHaveAttribute('data-motion', 'reduced')

  await choice.selectOption('always')
  await expect(root).toHaveAttribute('data-motion', 'full')
  await choice.selectOption('off')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(root).toHaveAttribute('data-motion', 'reduced')
  await choice.selectOption('system')
  await expect(root).toHaveAttribute('data-motion', 'full')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(root).toHaveAttribute('data-motion', 'reduced')
})
