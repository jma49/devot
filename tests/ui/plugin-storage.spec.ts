import { expect, openApp, test } from './fixtures'
import { pluginFrame, servePlugins, type TestPlugin } from './plugins'

// A plugin's own data and its settings (ADR 0021) through the runtime's `devot.storage` and `devot.settings`, from its
// sandboxed frame to the commands Rust answers. Rust is faked in the page.

const KEEPER = `
globalThis.log = []
devot.settings.onChange(async () => {
  globalThis.log.push(['changed', await devot.settings.get()])
})
;(async () => {
  await devot.storage.set('visits', { n: 1 })
  globalThis.log.push(['get', await devot.storage.get('visits')])
  globalThis.log.push(['keys', await devot.storage.keys()])
  globalThis.log.push(['settings', await devot.settings.get()])
  try {
    await devot.storage.set('bad key', 1)
  } catch (error) {
    globalThis.log.push(['refused', error.code])
  }
  await devot.storage.delete('visits')
  globalThis.log.push(['gone', await devot.storage.get('visits')])
})()
`

const plugin = (id: string, permissions: string[]): TestPlugin => ({
  manifest: {
    id,
    name: 'Keeper',
    version: '1.0.0',
    apiVersion: 2,
    main: 'main.js',
    permissions,
    contributes: {
      settings: [
        {
          id: 'unit',
          title: 'Unit',
          type: 'choice',
          choices: [
            { id: 'km', title: 'km' },
            { id: 'mi', title: 'mi' },
          ],
        },
      ],
    },
  },
  main: KEEPER,
})

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [
    plugin('com.example.keeper', ['storage']),
    plugin('com.example.bare', []),
  ])
  await page.addInitScript(() => {
    const w = window as unknown as Window & { stored: Map<string, unknown>; unit: string }
    w.stored = new Map()
    w.unit = 'km'
    const allowed = (id: string) => {
      if (id !== 'com.example.keeper') throw 'E_PLUGIN_PERMISSION_DENIED'
    }
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      plugin_storage_get: (a: { plugin: string; key: string }) => {
        allowed(a.plugin)
        return w.stored.get(a.key) ?? null
      },
      plugin_storage_set: (a: { plugin: string; key: string; value: unknown }) => {
        allowed(a.plugin)
        w.stored.set(a.key, a.value)
        return null
      },
      plugin_storage_delete: (a: { plugin: string; key: string }) => {
        allowed(a.plugin)
        w.stored.delete(a.key)
        return null
      },
      plugin_storage_keys: (a: { plugin: string }) => {
        allowed(a.plugin)
        return [...w.stored.keys()]
      },
      plugin_settings_get: () => ({ unit: w.unit }),
    }
  })
  await openApp(page)
})

const log = (frame: Awaited<ReturnType<typeof pluginFrame>>) =>
  frame.evaluate(() => (globalThis as { log?: unknown[] }).log ?? [])

test('a plugin stores, reads, lists and deletes its own values and reads its settings', async ({
  page,
}) => {
  const keeper = await pluginFrame(page, 'com.example.keeper')
  await expect
    .poll(() => log(keeper))
    .toEqual([
      ['get', { n: 1 }],
      ['keys', ['visits']],
      ['settings', { unit: 'km' }],
      ['refused', 'E_PLUGIN_MESSAGE_INVALID'],
      ['gone', null],
    ])
})

test('a plugin without the storage permission is refused, and still reads its settings', async ({
  page,
}) => {
  const bare = await pluginFrame(page, 'com.example.bare')
  type Runtime = {
    devot: { storage: { get(k: string): Promise<unknown> }; settings: { get(): Promise<unknown> } }
  }
  expect(
    await bare.evaluate(() =>
      (globalThis as unknown as Runtime).devot.storage.get('visits').then(
        () => 'read',
        (error: { code: string }) => error.code,
      ),
    ),
  ).toBe('E_PLUGIN_PERMISSION_DENIED')
  expect(
    await bare.evaluate(() => (globalThis as unknown as Runtime).devot.settings.get()),
  ).toEqual({ unit: 'km' })
})

test('a plugin is told when the user changes one of its settings', async ({ page }) => {
  const keeper = await pluginFrame(page, 'com.example.keeper')
  await expect.poll(async () => (await log(keeper)).length).toBe(5)
  await page.evaluate(() => {
    ;(window as unknown as { unit: string }).unit = 'mi'
    window.dispatchEvent(
      new CustomEvent('devot:plugin-settings-changed', { detail: 'com.example.keeper' }),
    )
  })
  await expect.poll(async () => (await log(keeper)).at(-1)).toEqual(['changed', { unit: 'mi' }])
})
