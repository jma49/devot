import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  paintedBackground,
  test,
  tokenColour,
} from './fixtures'

// A chosen appearance marks the root (`data-appearance`) and the generated tokens switch with it whatever the system
// shows. Stored with the editor settings, so a Settings window change arrives as `devot:editor-settings-changed`.

const EDITOR = { light: 'rgb(255, 255, 255)', dark: 'rgb(10, 10, 10)' } as const

const editorSurface = (page: Page) => tokenColour(page, '--color-surface-editor')

const settingsCalls = (page: Page) =>
  page.evaluate(() =>
    window.devotIpcCalls
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

  const half = (page: Page, theme: string, mode: 'Light' | 'Dark') =>
    page.getByRole('radio', { name: `${theme}, ${mode} Mode` })

  const card = (page: Page, theme: string) => page.getByRole('button', { name: theme, exact: true })

  test('one card per theme with a half for each appearance, the one shown named, Default chosen at first', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    await expect(
      page.getByRole('heading', { name: 'Themes \u2014 Light Mode Showing' }),
    ).toBeVisible()
    await expect(page.locator('.theme-card-name')).toHaveText([
      'Default',
      'Ivory',
      'Dawn',
      'Tide',
      'Sage',
      'Ember',
    ])
    for (const mode of ['Light', 'Dark'] as const) {
      await expect(half(page, 'Default', mode)).toBeChecked()
    }
    await expect(card(page, 'Default')).toHaveAttribute('aria-pressed', 'true')

    await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
    await expect(
      page.getByRole('heading', { name: 'Themes \u2014 Dark Mode Showing' }),
    ).toBeVisible()
  })

  test('a half stores the theme for its appearance and leaves the other alone', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    await half(page, 'Ivory', 'Light').check({ force: true })
    await expect(half(page, 'Ivory', 'Light')).toBeChecked()
    await expect(half(page, 'Default', 'Dark')).toBeChecked()
    await expect(card(page, 'Ivory')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
    await expect
      .poll(() => tokenColour(page, '--color-surface-sidebar-opaque'))
      .toBe('rgb(245, 244, 237)')
    await expect.poll(() => settingsCalls(page)).toEqual([{ lightTheme: 'ivory' }])

    await half(page, 'Tide', 'Dark').check({ force: true })
    await expect(half(page, 'Tide', 'Dark')).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
    await expect
      .poll(() => settingsCalls(page))
      .toEqual([{ lightTheme: 'ivory' }, { darkTheme: 'tide' }])
  })

  test('a card stores its theme for both appearances', async ({ page }) => {
    await openSettings(page, 'Appearance')
    await card(page, 'Tide').click()
    await expect(half(page, 'Tide', 'Light')).toBeChecked()
    await expect(half(page, 'Tide', 'Dark')).toBeChecked()
    await expect(card(page, 'Tide')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'tide')
    await expect
      .poll(() => settingsCalls(page))
      .toEqual([{ lightTheme: 'tide' }, { darkTheme: 'tide' }])
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
    await half(page, 'Sage', 'Light').check({ force: true })
    await expect(half(page, 'Sage', 'Light')).toBeChecked()
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
    const swatch = (theme: string, mode: 'Light' | 'Dark') =>
      page.locator('.theme-half', { has: half(page, theme, mode) }).locator('.swatch')
    const surface = (theme: string, mode: 'Light' | 'Dark') =>
      swatch(theme, mode).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(await surface('Default', 'Light')).toBe('rgb(255, 255, 255)')
    expect(await surface('Default', 'Dark')).toBe('rgb(10, 10, 10)')
    expect(await surface('Ivory', 'Dark')).toBe('rgb(48, 48, 46)')
    await expect(swatch('Dawn', 'Light')).toHaveCSS('background-image', /linear-gradient/)
    await expect(swatch('Default', 'Light')).toHaveCSS('background-image', 'none')
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
  test('starts with Lucide when no style was ever chosen', async ({ page }) => {
    await page.addInitScript(() => {
      window.devotEditorSettings = { iconStyle: undefined }
    })
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Icon style' })
    await expect(cards.getByRole('radio', { name: 'Lucide' })).toBeChecked()
    await expect(page.locator('.settings-nav-row svg.lucide').first()).toBeVisible()
    await expect(page.locator('.settings-nav-row [data-symbol]')).toHaveCount(0)
  })

  test('draws SF Symbols when chosen and Lucide SVGs once switched, whatever the theme', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Icon style' })
    await expect(cards.getByRole('radio', { name: 'SF Symbols' })).toBeChecked()
    await expect(cards.locator('svg')).toHaveCount(6)
    await expect(cards.locator('svg[data-kubai]')).toHaveCount(2)
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

  test('draws Kubai glyphs once chosen, keeping Lucide marks where Kubai has none', async ({
    page,
  }) => {
    await openSettings(page, 'Appearance')
    const cards = page.getByRole('radiogroup', { name: 'Icon style' })
    await cards.getByText('Kubai', { exact: true }).click()
    await expect(cards.getByRole('radio', { name: 'Kubai' })).toBeChecked()
    await expect.poll(() => settingsCalls(page)).toEqual([{ iconStyle: 'kubai' }])
    const nav = page.locator('.settings-nav-row svg[data-kubai]').first()
    await expect(nav).toBeVisible()
    await expect(page.locator('.settings-nav-row [data-symbol]')).toHaveCount(0)
    const box = await nav.boundingBox()
    expect(box?.width).toBeGreaterThan(10)
    expect(box?.width).toBeLessThan(30)
    // Its light tone is painted by kubaiGlyphs.css, not by style attributes.
    await expect(nav.locator('path.ki-p1').first()).not.toHaveCSS('fill', 'rgb(0, 0, 0)')
  })
})
