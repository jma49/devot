import type { Page } from '@playwright/test'
import { expect, openApp, openSettings, test } from './fixtures'

// Plugin themes (ADR 0026). Rust is faked in the page: it lists the themes of plugins that are on and keeps the choice
// for each appearance (src-tauri/src/plugins/mod.rs).

test.use({ colorScheme: 'light' })

const nord = {
  plugin: 'com.example.nord',
  pluginName: 'Nord',
  id: 'nord-light',
  title: 'Nord Light',
  appearance: 'light',
  colors: { 'surface-editor': '#eceff4', 'not-a-token': '#000000' },
}

async function fakeRust(page: Page, chosen: boolean) {
  await page.addInitScript(
    ({ theme, startChosen }) => {
      const w = window
      const answer = (on: boolean) => ({
        themes: [theme],
        chosen: { light: on ? { plugin: theme.plugin, theme: theme.id } : null, dark: null },
      })
      let on = startChosen
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        plugin_themes: () => answer(on),
        plugin_theme_choose: (args: { theme: unknown }) => {
          on = args.theme !== null
          window.dispatchEvent(new CustomEvent('devot:plugin-themes-changed'))
          return null
        },
      }
    },
    { theme: nord, startChosen: chosen },
  )
}

const rootColor = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--color-surface-editor'))

test('draws the chosen plugin theme over the window’s theme', async ({ page }) => {
  await fakeRust(page, true)
  await openApp(page)
  await expect.poll(() => rootColor(page)).toBe('#eceff4')
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--color-not-a-token'),
    ),
  ).toBe('')
  await expect(page.locator('html')).toHaveAttribute(
    'data-plugin-theme',
    'com.example.nord/nord-light',
  )
})

test('chooses a plugin theme in Settings and takes it off again', async ({ page }) => {
  await fakeRust(page, false)
  await openSettings(page, 'Appearance')
  const light = page.getByRole('combobox', { name: 'Plugin Theme' })
  await expect(light).toHaveCount(1)
  await expect(light).toHaveValue('')
  await light.selectOption({ label: 'Nord Light (Nord)' })
  await expect.poll(() => rootColor(page)).toBe('#eceff4')
  await expect(light).toHaveValue('com.example.nord/nord-light')
  await light.selectOption({ label: 'None' })
  await expect.poll(() => rootColor(page)).toBe('')
  expect(
    await page.evaluate(() =>
      window.devotIpcCalls.filter((c) => c.cmd === 'plugin_theme_choose').map((c) => c.args),
    ),
  ).toEqual([
    { appearance: 'light', theme: { plugin: 'com.example.nord', theme: 'nord-light' } },
    { appearance: 'light', theme: null },
  ])
})
