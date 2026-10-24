import type { Page } from '@playwright/test'
import { expect, openSettings, test, type TestWindow } from './fixtures'

// Settings > Plugins. Rust is faked in the page: it keeps the installed plugins, stages a package when one is picked and
// installs it only on confirmation, as src-tauri/src/plugins/mod.rs does.

const manifest = (version: string, permissions: string[]) => ({
  id: 'com.example.counter',
  name: 'Counter',
  version,
  apiVersion: 1,
  description: 'Counts words.',
  author: 'Example',
  main: 'main.js',
  permissions,
  contributes: { commands: [{ id: 'count', title: 'Count' }] },
})

async function fakeRust(page: Page, picked: ReturnType<typeof manifest> | null) {
  await page.addInitScript((staged) => {
    const w = globalThis as unknown as TestWindow & { devotPlugins: unknown[] }
    w.devotPlugins = []
    const changed = () => window.dispatchEvent(new CustomEvent('devot:plugins-changed'))
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      plugins_list: () => w.devotPlugins,
      plugin_install_pick: () =>
        staged && {
          token: 7,
          manifest: staged,
          replaces: w.devotPlugins.length > 0 ? { version: '1.0.0', granted: ['commands'] } : null,
        },
      plugin_install_confirm: (args: { token: number }) => {
        if (args.token !== 7 || !staged) throw 'E_PLUGIN_STAGED_MISSING'
        const installed = { manifest: staged, enabled: true, granted: staged.permissions }
        w.devotPlugins = [installed]
        changed()
        return installed
      },
      plugin_install_cancel: () => null,
      plugin_set_enabled: (args: { id: string; enabled: boolean }) => {
        w.devotPlugins = w.devotPlugins.map((p) => ({ ...(p as object), enabled: args.enabled }))
        changed()
        return null
      },
      plugin_remove: () => {
        w.devotPlugins = []
        changed()
        return null
      },
    }
  }, picked)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((x) => x.cmd === c)
        .map((x) => x.args),
    cmd,
  )

const list = (page: Page) => page.getByRole('list', { name: 'Installed plugins' })

test('installs a plugin only after its permissions are shown and approved', async ({ page }) => {
  await fakeRust(page, manifest('1.0.0', ['note.read', 'commands']))
  await openSettings(page, 'Plugins')
  await expect(page.getByText('No plugins are installed.')).toBeVisible()
  await page.getByRole('button', { name: 'Install from Folder…' }).click()
  const review = page.getByRole('dialog', { name: 'Install “Counter”?' })
  await expect(review).toBeVisible()
  await expect(review.getByRole('listitem')).toHaveText([
    'Read the open note while you use it',
    'Add commands to the command palette',
  ])
  await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused()
  expect(await calls(page, 'plugin_install_confirm')).toEqual([])
  await review.getByRole('button', { name: 'Install' }).click()
  await expect(review).toBeHidden()
  expect(await calls(page, 'plugin_install_pick')).toEqual([{ kind: 'folder' }])
  expect(await calls(page, 'plugin_install_confirm')).toEqual([{ token: 7 }])
  const row = list(page).getByRole('listitem').first()
  await expect(row).toContainText('Counter')
  await expect(row).toContainText('Version 1.0.0 by Example')
  await expect(row).toContainText('Read the open note while you use it')
  await expect(page.getByRole('switch', { name: 'Turn Counter on or off' })).toBeChecked()
})

test('installs nothing when the review is cancelled', async ({ page }) => {
  await fakeRust(page, manifest('1.0.0', ['commands']))
  await openSettings(page, 'Plugins')
  await page.getByRole('button', { name: 'Install from Archive…' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await calls(page, 'plugin_install_pick')).toEqual([{ kind: 'archive' }])
  expect(await calls(page, 'plugin_install_cancel')).toEqual([{ token: 7 }])
  expect(await calls(page, 'plugin_install_confirm')).toEqual([])
  await expect(page.getByText('No plugins are installed.')).toBeVisible()
})

test('says what a new version replaces', async ({ page }) => {
  await fakeRust(page, manifest('2.0.0', ['commands', 'note.edit']))
  await page.addInitScript(() => {
    const w = globalThis as unknown as { devotPlugins: unknown[] }
    w.devotPlugins = [
      {
        manifest: {
          id: 'com.example.counter',
          name: 'Counter',
          version: '1.0.0',
          apiVersion: 1,
          main: 'main.js',
          permissions: ['commands'],
          contributes: { commands: [{ id: 'count', title: 'Count' }] },
        },
        enabled: true,
        granted: ['commands'],
      },
    ]
  })
  await openSettings(page, 'Plugins')
  await page.getByRole('button', { name: 'Install from Folder…' }).click()
  const review = page.getByRole('dialog', { name: 'Install “Counter”?' })
  await expect(review).toContainText('This replaces version 1.0.0 with version 2.0.0.')
  await expect(review.getByRole('listitem')).toHaveText([
    'Add commands to the command palette',
    'Change the open note while you use it',
  ])
})

test('turns a plugin off and on, and removes it after asking', async ({ page }) => {
  await fakeRust(page, manifest('1.0.0', ['commands']))
  await openSettings(page, 'Plugins')
  await page.getByRole('button', { name: 'Install from Folder…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Install' }).click()
  const toggle = page.getByRole('switch', { name: 'Turn Counter on or off' })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  expect(await calls(page, 'plugin_set_enabled')).toEqual([
    { id: 'com.example.counter', enabled: false },
  ])
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.getByRole('button', { name: 'Remove Counter' }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove “Counter”?' })
  await confirm.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('No plugins are installed.')).toBeVisible()
  expect(await calls(page, 'plugin_remove')).toEqual([{ id: 'com.example.counter' }])
})

test('shows why a package was refused, by its code', async ({ page }) => {
  await fakeRust(page, null)
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, plugin_install_pick: { error: 'E_PLUGIN_API_VERSION' } }
  })
  await openSettings(page, 'Plugins')
  await page.getByRole('button', { name: 'Install from Archive…' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'The plugin could not be installed (E_PLUGIN_API_VERSION).',
  )
})
