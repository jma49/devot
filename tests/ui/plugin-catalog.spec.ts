import type { Page } from '@playwright/test'
import { expect, openSettings, test } from './fixtures'

// Settings > Plugins > Official Plugins. Rust is faked in the page: it lists the index and stages a listed plugin's
// archive for the same review as a picked package (src-tauri/src/plugins/catalog.rs).

const offered = (offer: string, installed: string | null = null) => ({
  id: 'online.devot.charts',
  name: 'Charts',
  version: '1.1.0',
  description: 'Draws chart code blocks.',
  author: 'Devot',
  permissions: ['preview'],
  installed,
  offer,
})

const manifest = {
  id: 'online.devot.charts',
  name: 'Charts',
  version: '1.1.0',
  apiVersion: 1,
  description: 'Draws chart code blocks.',
  author: 'Devot',
  main: 'main.js',
  permissions: ['preview'],
  contributes: { previewRenderers: [{ id: 'chart', language: 'chart' }] },
}

async function fakeRust(page: Page, list: unknown[] | { error: string }) {
  await page.addInitScript(
    ({ offers, staged }) => {
      const w = window
      w.devotPlugins = []
      w.devotIpcMocks = {
        ...w.devotIpcMocks,
        plugins_list: () => w.devotPlugins,
        plugin_catalog: offers,
        plugin_catalog_stage: () => ({ token: 9, manifest: staged, replaces: null }),
        plugin_install_confirm: () => {
          const installed = { manifest: staged, enabled: true, granted: staged.permissions }
          w.devotPlugins = [installed]
          w.devotIpcMocks = {
            ...w.devotIpcMocks,
            plugin_catalog: [
              { ...(offers as object[])[0], installed: '1.1.0', offer: 'installed' },
            ],
          }
          window.dispatchEvent(new CustomEvent('devot:plugins-changed'))
          return installed
        },
        plugin_install_cancel: () => null,
      }
    },
    { offers: list, staged: manifest },
  )
}

const calls = (page: Page, cmd: string) =>
  page.evaluate((c) => window.devotIpcCalls.filter((x) => x.cmd === c).map((x) => x.args), cmd)

const official = (page: Page) => page.getByRole('list', { name: 'Official plugins' })

test('installs an official plugin after the same review as a picked one', async ({ page }) => {
  await fakeRust(page, [offered('install')])
  await openSettings(page, 'Plugins')
  const row = official(page).getByRole('listitem').first()
  await expect(row).toContainText('Charts')
  await expect(row).toContainText('Version 1.1.0 by Devot')
  await row.getByRole('button', { name: 'Install Charts' }).click()
  const review = page.getByRole('dialog', { name: 'Install “Charts”?' })
  await expect(review.getByRole('listitem')).toHaveText([
    'Draw code blocks of its languages in the preview',
  ])
  expect(await calls(page, 'plugin_catalog_stage')).toEqual([{ id: 'online.devot.charts' }])
  await review.getByRole('button', { name: 'Install' }).click()
  await expect(review).toBeHidden()
  expect(await calls(page, 'plugin_install_confirm')).toEqual([{ token: 9 }])
  await expect(row).toContainText('Installed')
  await expect(row.getByRole('button')).toHaveCount(0)
  await expect(
    page.getByRole('list', { name: 'Installed plugins' }).getByRole('listitem').first(),
  ).toContainText('Charts')
})

test('offers an update and says when Devot is too old', async ({ page }) => {
  await fakeRust(page, [
    offered('update', '1.0.0'),
    { ...offered('needsNewerApp'), id: 'online.devot.later', name: 'Later' },
  ])
  await openSettings(page, 'Plugins')
  await expect(
    official(page).getByRole('button', { name: 'Update Charts to version 1.1.0' }),
  ).toBeVisible()
  const later = official(page).getByRole('listitem').nth(1)
  await expect(later).toContainText('Needs a newer Devot')
  await expect(later.getByRole('button')).toHaveCount(0)
})

test('says when the list cannot be loaded and tries again', async ({ page }) => {
  await fakeRust(page, { error: 'E_PLUGIN_INDEX_UNAVAILABLE' })
  await openSettings(page, 'Plugins')
  await expect(page.getByText(/The official plugins could not be listed/)).toBeVisible()
  await page.evaluate(() => {
    window.devotIpcMocks = { ...window.devotIpcMocks, plugin_catalog: [] }
  })
  await page.getByRole('button', { name: 'Try Again' }).click()
  await expect(page.getByText(/could not be listed/)).toBeHidden()
  expect((await calls(page, 'plugin_catalog')).length).toBe(2)
})
