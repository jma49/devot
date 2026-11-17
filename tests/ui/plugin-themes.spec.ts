import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, openSettings, test } from './fixtures'

// Plugin themes (ADR 0026) in Settings > Appearance: each plugin that adds themes is one card beside the built-in ones,
// with its Light Mode and Dark Mode swatches. Rust is faked in the page: it lists the themes of plugins that are on and
// keeps the choice for each appearance (src-tauri/src/plugins/mod.rs).

test.use({ colorScheme: 'light' })

const theme = (
  plugin: string,
  pluginName: string,
  id: string,
  title: string,
  appearance: 'light' | 'dark',
  editor: string,
) => ({
  plugin,
  pluginName,
  id,
  title,
  appearance,
  colors: {
    'surface-editor': editor,
    'accent-fill': '#8839ef',
    'not-a-token': '#000000',
    'status-active-mark': '#ff00ff',
    'icon-tile-general': '#ff00ff',
  },
})

const CAT = 'online.devot.theme-catppuccin'
const THEMES = [
  theme(CAT, 'Catppuccin', 'latte', 'Catppuccin Latte', 'light', '#eff1f5'),
  theme(CAT, 'Catppuccin', 'frappe', 'Catppuccin Frappé', 'dark', '#303446'),
  theme(CAT, 'Catppuccin', 'macchiato', 'Catppuccin Macchiato', 'dark', '#24273a'),
  theme(CAT, 'Catppuccin', 'mocha', 'Catppuccin Mocha', 'dark', '#1e1e2e'),
  theme('online.devot.theme-dracula', 'Dracula', 'dracula', 'Dracula', 'dark', '#282a36'),
]

type Ref = { plugin: string; theme: string } | null

async function fakeRust(
  page: Page,
  chosen: { light: Ref; dark: Ref } = { light: null, dark: null },
) {
  await page.addInitScript(
    ({ themes, start }) => {
      const w = window
      const now = { ...start }
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        plugin_themes: () => ({ themes, chosen: now }),
        plugin_theme_choose: (args: { appearance: 'light' | 'dark'; theme: Ref }) => {
          now[args.appearance] = args.theme
          window.dispatchEvent(new CustomEvent('devot:plugin-themes-changed'))
          return null
        },
      }
    },
    { themes: THEMES, start: chosen },
  )
}

const rootColor = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--color-surface-editor'))

const choices = (page: Page) =>
  page.evaluate(() =>
    window.devotIpcCalls
      .filter((c) => c.cmd === 'plugin_theme_choose' || c.cmd === 'editor_settings_set')
      .map((c) => c.args),
  )

const card = (page: Page, name: string) =>
  page.locator('.theme-card').filter({ has: page.getByRole('button', { name, exact: true }) })

test('draws the chosen plugin theme over the window’s theme, in light, dark and following the system', async ({
  page,
}) => {
  await fakeRust(page, {
    light: { plugin: CAT, theme: 'latte' },
    dark: { plugin: CAT, theme: 'mocha' },
  })
  await openApp(page)
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--color-not-a-token'),
    ),
  ).toBe('')
  await expect(page.locator('html')).toHaveAttribute('data-plugin-theme', `${CAT}/latte`)
  // Icons keep Devot's colors under every theme.
  expect(
    await page.evaluate(() =>
      ['--color-status-active-mark', '--color-icon-tile-general'].map((name) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
      ),
    ),
  ).not.toContain('#ff00ff')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => rootColor(page)).toBe('#1e1e2e')
  await changeEditorSettingsElsewhere(page, { appearance: 'light' })
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
  await expect.poll(() => rootColor(page)).toBe('#1e1e2e')
})

test('a window opened again paints the chosen plugin theme before Rust answers', async ({
  page,
}) => {
  await fakeRust(page, { light: { plugin: CAT, theme: 'latte' }, dark: null })
  await openApp(page)
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  await page.addInitScript(() => {
    window.devotIpcMocks = { ...window.devotIpcMocks, plugin_themes: () => new Promise(() => {}) }
  })
  await page.reload()
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  await expect(page.locator('html')).toHaveAttribute('data-plugin-theme', `${CAT}/latte`)
})

test('shows each plugin as a card of its light and dark themes after the built-in ones', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Appearance')
  await expect(page.locator('.theme-card-name')).toHaveText([
    'Default',
    'Ivory',
    'Dawn',
    'Tide',
    'Sage',
    'Ember',
    'Catppuccin',
    'Dracula',
  ])
  await expect(page.getByRole('heading', { name: 'Themes — Light Mode Showing' })).toBeVisible()
  const catppuccin = card(page, 'Catppuccin')
  await expect(catppuccin.locator('.theme-half-caption')).toHaveText(['Latte', 'Frappé'])
  await expect(catppuccin.locator('.theme-variant')).toHaveCount(3)
  await expect(catppuccin.locator('.swatch').first()).toHaveCSS(
    'background-color',
    'rgb(239, 241, 245)',
  )
  await expect(card(page, 'Dracula').locator('.swatch-missing')).toHaveText('No light colors')
  await expect(page.getByRole('radio', { name: 'Default, Light Mode' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Default, Dark Mode' })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Default', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('a theme’s card chooses it for both appearances, a swatch or a dot for one', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Appearance')
  await page.getByRole('button', { name: 'Catppuccin', exact: true }).click()
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  await expect(page.getByRole('radio', { name: 'Catppuccin Latte, Light Mode' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Catppuccin Frappé, Dark Mode' })).toBeChecked()

  await card(page, 'Catppuccin')
    .getByRole('button', { name: 'Catppuccin Mocha, Dark Mode' })
    .click()
  await expect(page.getByRole('radio', { name: 'Catppuccin Mocha, Dark Mode' })).toBeChecked()

  await page.getByRole('radio', { name: 'Ivory, Light Mode' }).check({ force: true })
  await expect.poll(() => rootColor(page)).toBe('')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ivory')
  await expect(page.getByRole('radio', { name: 'Catppuccin Mocha, Dark Mode' })).toBeChecked()

  await page.getByRole('button', { name: 'Dracula', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Dracula, Dark Mode' })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Ivory, Light Mode' })).toBeChecked()

  // Rust and the editor settings are asked in parallel, so only the order of each one's own calls is fixed.
  const calls = await choices(page)
  expect(calls.filter((c) => 'appearance' in c)).toEqual([
    { appearance: 'light', theme: { plugin: CAT, theme: 'latte' } },
    { appearance: 'dark', theme: { plugin: CAT, theme: 'frappe' } },
    { appearance: 'dark', theme: { plugin: CAT, theme: 'mocha' } },
    { appearance: 'light', theme: null },
    { appearance: 'dark', theme: { plugin: 'online.devot.theme-dracula', theme: 'dracula' } },
  ])
  expect(calls.filter((c) => 'patch' in c)).toEqual([{ patch: { lightTheme: 'ivory' } }])
})

test('a plugin theme takes the place of a built-in one, which goes back to Default', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Appearance')
  await changeEditorSettingsElsewhere(page, { lightTheme: 'tide' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tide')
  await page.getByRole('radio', { name: 'Catppuccin Latte, Light Mode' }).check({ force: true })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  await expect.poll(() => rootColor(page)).toBe('#eff1f5')
  await expect(page.getByRole('radio', { name: 'Tide, Light Mode' })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: 'Default, Light Mode' })).not.toBeChecked()
})

test('Get More Themes opens the plugins', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Appearance')
  await page.getByRole('button', { name: 'Get More Themes' }).click()
  await expect(page.getByRole('tab', { name: 'Plugins', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

for (const locale of ['en-US', 'zh-CN']) {
  test.describe(locale, () => {
    test.use({ locale })

    test('every card fits the Settings window, names and captions whole', async ({ page }) => {
      await fakeRust(page)
      // The Settings window's one size (src-tauri/src/settings.rs).
      await page.setViewportSize({ width: 900, height: 680 })
      await page.goto('/settings.html?pane=appearance')
      await expect(page.locator('.theme-card')).toHaveCount(9)
      const fit = () =>
        page.locator('.theme-grid').evaluate((grid) => {
          const section = grid.closest('.settings-card')!
          const edge = section.getBoundingClientRect().right
          const clipped = [
            ...grid.querySelectorAll<HTMLElement>('.theme-card-name, .theme-half-caption'),
          ]
            .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
            .map((el) => el.textContent)
          return {
            scroll: grid.scrollWidth - grid.clientWidth,
            past: [...grid.querySelectorAll('.theme-card')].filter(
              (c) => c.getBoundingClientRect().right > edge + 0.5,
            ).length,
            columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            clipped,
          }
        })
      expect(await fit()).toEqual({ scroll: 0, past: 0, columns: 3, clipped: [] })
    })
  })
}
