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
    const cards = page.getByRole('radiogroup', { name: 'Color scheme' })
    await expect(cards.getByRole('radio')).toHaveCount(3)
    await expect(cards.getByRole('radio', { name: 'Auto' })).toBeChecked()

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

// Each appearance has its own theme; the one for the appearance shown marks the root (`data-theme`). The generated
// tokens scope each built-in theme by it, and the choice reaches every window like the appearance does.

/** The sheet the note list and the editor share over the window material, per theme and appearance. */
const SHEET = {
  default: { light: 'rgba(255, 255, 255, 0.75)', dark: 'rgba(18, 18, 18, 0.7)' },
  ivory: { light: 'rgba(253, 252, 248, 0.75)', dark: 'rgba(43, 43, 41, 0.7)' },
} as const
const SURFACES = {
  default: {
    light: { editor: SHEET.default.light, list: SHEET.default.light },
    dark: { editor: SHEET.default.dark, list: SHEET.default.dark },
  },
  ivory: {
    light: { editor: SHEET.ivory.light, list: SHEET.ivory.light },
    dark: { editor: SHEET.ivory.dark, list: SHEET.ivory.dark },
  },
} as const

const shownSurfaces = async (page: Page) => ({
  editor: await paintedBackground(page.locator('main.content')),
  list: await paintedBackground(page.getByRole('region', { name: 'Notes' })),
})

for (const scheme of ['light', 'dark'] as const) {
  const other = scheme === 'light' ? 'dark' : 'light'
  test.describe(`the theme with the system in ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('Ivory for the appearance shown changes the editor and the note list colours at once; for the other it waits', async ({
      page,
    }) => {
      await page.goto('/')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')

      await changeEditorSettingsElsewhere(page, { [`${other}Theme`]: 'ivory' })
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])

      await changeEditorSettingsElsewhere(page, { [`${scheme}Theme`]: 'ivory' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.ivory[scheme])

      await changeEditorSettingsElsewhere(page, { [`${scheme}Theme`]: 'default' })
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])
    })

    test('the chosen appearance picks its own theme, not the system', async ({ page }) => {
      await page.goto('/')
      await changeEditorSettingsElsewhere(page, {
        [`${other}Theme`]: 'ivory',
        [`${scheme}Theme`]: 'default',
        appearance: other,
      })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.ivory[other])
      await changeEditorSettingsElsewhere(page, {
        [`${other}Theme`]: 'ivory',
        appearance: 'system',
      })
      await expect(page.locator('html')).not.toHaveAttribute('data-theme')
      await expect.poll(() => shownSurfaces(page)).toEqual(SURFACES.default[scheme])
    })

    test('while the window follows the system, a system switch brings the other appearance its theme', async ({
      page,
    }) => {
      await page.goto('/')
      await changeEditorSettingsElsewhere(page, { lightTheme: 'ivory', darkTheme: 'tide' })
      const theme = { light: 'ivory', dark: 'tide' } as const
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme[scheme])
      await page.emulateMedia({ colorScheme: other })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme[other])
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme[scheme])
    })
  })
}

test.describe('the theme choices in Settings', () => {
  test.use({ colorScheme: 'light' })

  const picker = (page: Page, mode: 'Light' | 'Dark') =>
    page.getByRole('radiogroup', { name: `${mode} Mode Theme` })

  test('one per appearance, the one shown marked Active, each with Default chosen at first', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    await expect(page.getByRole('heading', { name: 'Light Mode \u2014 Active' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Dark Mode', exact: true })).toBeVisible()
    for (const mode of ['Light', 'Dark'] as const) {
      await expect(picker(page, mode).getByRole('radio', { name: 'Default' })).toBeChecked()
      await expect(picker(page, mode).locator('.choice-group-label')).toHaveText([
        'Default',
        'Built-in',
      ])
      await expect(picker(page, mode).locator('.choice-name')).toHaveText([
        'Default',
        'Ivory',
        'Dawn',
        'Tide',
        'Sage',
        'Ember',
      ])
    }

    await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
    await expect(page.getByRole('heading', { name: 'Dark Mode \u2014 Active' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Light Mode', exact: true })).toBeVisible()
  })

  test('stores the light theme and shows it, and leaves the dark one alone', async ({ page }) => {
    await openSettings(page, 'Appearance')
    await picker(page, 'Light').getByText('Ivory', { exact: true }).click()
    await expect(picker(page, 'Light').getByRole('radio', { name: 'Ivory' })).toBeChecked()
    await expect(picker(page, 'Dark').getByRole('radio', { name: 'Default' })).toBeChecked()
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
    await expect.poll(() => settingsCalls(page)).toEqual([{ lightTheme: 'ivory' }])

    await picker(page, 'Dark').getByText('Tide', { exact: true }).click()
    await expect(picker(page, 'Dark').getByRole('radio', { name: 'Tide' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
    await expect
      .poll(() => settingsCalls(page))
      .toEqual([{ lightTheme: 'ivory' }, { darkTheme: 'tide' }])
  })

  test('hides the system accent option while Ivory is in effect, and only then', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const accent = page.getByRole('switch', { name: 'Use the System Accent Color' })
    await expect(accent).toBeEnabled()

    await changeEditorSettingsElsewhere(page, { darkTheme: 'ivory' })
    await expect(accent).toBeEnabled()
    await changeEditorSettingsElsewhere(page, { lightTheme: 'ivory' })
    await expect(accent).toHaveCount(0)
    await changeEditorSettingsElsewhere(page, { lightTheme: 'default' })
    await expect(accent).toBeEnabled()
  })

  test('a gradient theme keeps the default colours and accent', async ({ page }) => {
    await openSettings(page, 'Appearance')
    await picker(page, 'Light').getByText('Sage', { exact: true }).click()
    await expect(picker(page, 'Light').getByRole('radio', { name: 'Sage' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sage')
    await expect
      .poll(() =>
        page.evaluate(
          () => getComputedStyle(document.querySelector('.settings-nav')!).backgroundImage,
        ),
      )
      .toContain('linear-gradient')
    await expect(page.getByRole('switch', { name: 'Use the System Accent Color' })).toBeEnabled()
    await expect.poll(() => settingsCalls(page)).toEqual([{ lightTheme: 'sage' }])
  })

  test('each swatch shows its own theme whatever the window shows', async ({ page }) => {
    await openSettings(page, 'Appearance')
    await changeEditorSettingsElsewhere(page, { lightTheme: 'ivory' })
    const swatch = (mode: 'Light' | 'Dark', name: string) =>
      picker(page, mode).locator('.choice', { hasText: name }).locator('.swatch')
    const surface = (mode: 'Light' | 'Dark', name: string) =>
      swatch(mode, name).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await surface('Light', 'Default')).toBe('rgb(255, 255, 255)')
    expect(await surface('Dark', 'Default')).toBe('rgb(10, 10, 10)')
    expect(await surface('Dark', 'Ivory')).toBe('rgb(48, 48, 46)')
    await expect(swatch('Light', 'Dawn')).toHaveCSS('background-image', /linear-gradient/)
    await expect(swatch('Light', 'Default')).toHaveCSS('background-image', 'none')
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

test.describe('the Icon style choice in Settings', () => {
  test('starts with SF Symbols and draws Lucide SVGs once chosen, whatever the theme', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Icon style' })
    await expect(cards.getByRole('radio', { name: 'SF Symbols' })).toBeChecked()
    await expect(cards.locator('svg')).toHaveCount(3)
    await expect(cards.locator('[data-symbol]')).toHaveCount(3)
    await expect(page.locator('.settings-nav-row [data-symbol]').first()).toBeVisible()
    await expect(page.locator('.settings-nav-row svg')).toHaveCount(0)

    await cards.getByText('Lucide', { exact: true }).click()
    await expect(cards.getByRole('radio', { name: 'Lucide' })).toBeChecked()
    await expect(page.locator('.settings-nav-row svg').first()).toBeVisible()
    await expect(page.locator('.settings-nav-row [data-symbol]')).toHaveCount(0)
    await expect.poll(() => settingsCalls(page)).toEqual([{ iconStyle: 'lucide' }])

    await changeEditorSettingsElsewhere(page, { lightTheme: 'ivory', iconStyle: 'lucide' })
    await expect(page.locator('.settings-nav-row svg').first()).toBeVisible()
    await changeEditorSettingsElsewhere(page, { iconStyle: 'sfSymbols' })
    await expect(page.locator('.settings-nav-row svg')).toHaveCount(0)
    await expect(page.locator('.settings-nav-row [data-symbol]').first()).toBeVisible()
  })
})
