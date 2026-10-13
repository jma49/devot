import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  test,
  type TestWindow,
} from './fixtures'

// The sidebar material (Settings > Appearance). With it on (the default) the
// sidebar lets the window's material show through a light tint; turned off,
// the sidebar and the root paint an opaque surface, in light and dark, and
// the page asks Rust (`sidebar_material_sync`) to drop the window effect.
// The order keeps the desktop from showing through a bare tint: off paints
// opaque before Rust drops the effect, on waits for Rust to restore it. The
// setting is stored with the editor settings, so a change in the Settings
// window reaches the main window as `devot:editor-settings-changed`.

/** The sidebar's surfaces (`color.surface.sidebar` and `-opaque`). */
const SURFACES = {
  light: { material: 'rgba(241, 240, 237, 0.7)', opaque: 'rgb(241, 240, 237)' },
  dark: { material: 'rgba(28, 27, 25, 0.7)', opaque: 'rgb(28, 27, 25)' },
} as const
const CLEAR = 'rgba(0, 0, 0, 0)'

const root = (page: Page) => page.locator('html')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const appearance = (page: Page) => page.getByRole('region', { name: 'Appearance' })
const translucent = (page: Page) =>
  appearance(page).getByRole('checkbox', { name: 'Translucent sidebar' })

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

/** Settings stored before the page starts (the rest are defaults). */
const stored = (page: Page, settings: Record<string, unknown>) =>
  page.addInitScript((s) => {
    const w = globalThis as unknown as TestWindow
    w.devotEditorRevision = 2
    w.devotEditorSettings = s
  }, settings)

async function expectShown(page: Page, material: boolean, scheme: 'light' | 'dark' = 'light') {
  await expect(root(page)).toHaveAttribute('data-sidebar-material', material ? 'on' : 'off')
  const surface = SURFACES[scheme][material ? 'material' : 'opaque']
  await expect(sidebar(page)).toHaveCSS('background-color', surface)
  // Behind every pane: clear over the material, opaque without it.
  await expect(root(page)).toHaveCSS('background-color', material ? CLEAR : SURFACES[scheme].opaque)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} appearance`, () => {
    test.use({ colorScheme: scheme })

    test('the sidebar shows the material by default', async ({ page }) => {
      await page.goto('/')
      await expectShown(page, true, scheme)
      expect(await calls(page, 'sidebar_material_sync')).toHaveLength(0)
    })

    test('an opaque sidebar is remembered and follows changes at once', async ({ page }) => {
      await stored(page, { sidebarMaterial: false })
      await page.goto('/')
      await expectShown(page, false, scheme)

      // Turned on in the Settings window: no reload needed.
      await changeEditorSettingsElsewhere(page, { sidebarMaterial: true })
      await expectShown(page, true, scheme)

      await changeEditorSettingsElsewhere(page, { sidebarMaterial: false, fontSize: 15 })
      await expectShown(page, false, scheme)
      await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(3)
    })
  })
}

test('the first paint matches the settings the window was built with', async ({ page }) => {
  // What Rust hands the page before its scripts run; the stored settings
  // themselves never answer here.
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & { devotInitialEditorSettings: unknown }
    w.devotInitialEditorSettings = { revision: 0, settings: { sidebarMaterial: false } }
    w.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
  })
  await page.goto('/')
  await expectShown(page, false)
  // The window was built without the effect already: nothing to change.
  expect(await calls(page, 'sidebar_material_sync')).toHaveLength(0)
})

test('turned on, the sidebar stays opaque until Rust has restored the effect', async ({ page }) => {
  await stored(page, { sidebarMaterial: false })
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & { devotFinishSync?: () => void }
    w.devotIpcMocks = {
      sidebar_material_sync: () =>
        new Promise((resolve) => {
          w.devotFinishSync = () => resolve(true)
        }),
    }
  })
  await page.goto('/')
  await expectShown(page, false)
  // The stored settings turned it off once read: one sync so far.
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(1)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: true })
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(2)
  await expectShown(page, false)
  await page.evaluate(() =>
    (globalThis as unknown as { devotFinishSync: () => void }).devotFinishSync(),
  )
  await expectShown(page, true)
})

test('turned off, the sidebar is painted opaque before Rust drops the effect', async ({ page }) => {
  // Frames are counted; the change to off and the sync each note the frame
  // they happen in. A frame after the change has been rendered once the
  // counter has moved on twice (the first step only starts that frame).
  await page.addInitScript(() => {
    const g = globalThis as unknown as TestWindow & {
      document: unknown
      requestAnimationFrame(cb: () => void): number
      MutationObserver: new (cb: () => void) => {
        observe(target: unknown, options: Record<string, unknown>): void
      }
      devotFrame: number
      devotOffAtFrame?: number
      devotSyncAtFrame: { frame: number; shown: string }[]
    }
    g.devotFrame = 0
    g.devotSyncAtFrame = []
    const tick = () => {
      g.devotFrame += 1
      g.requestAnimationFrame(tick)
    }
    g.requestAnimationFrame(tick)
    const html = () =>
      (g.document as { documentElement: { getAttribute(name: string): string | null } })
        .documentElement
    new g.MutationObserver(() => {
      if (html().getAttribute('data-sidebar-material') === 'off' && g.devotOffAtFrame === undefined)
        g.devotOffAtFrame = g.devotFrame
    }).observe(g.document, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-sidebar-material'],
    })
    g.devotIpcMocks = {
      sidebar_material_sync: () => {
        g.devotSyncAtFrame.push({
          frame: g.devotFrame,
          shown: html().getAttribute('data-sidebar-material') ?? '',
        })
        return false
      },
    }
  })
  await page.goto('/')
  await expectShown(page, true)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expectShown(page, false)
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as unknown as { devotSyncAtFrame: unknown[] }).devotSyncAtFrame.length,
      ),
    )
    .toBe(1)
  const { off, sync } = await page.evaluate(() => {
    const g = globalThis as unknown as {
      devotOffAtFrame: number
      devotSyncAtFrame: { frame: number; shown: string }[]
    }
    return { off: g.devotOffAtFrame, sync: g.devotSyncAtFrame[0] }
  })
  expect(sync?.shown).toBe('off')
  expect(sync!.frame - off).toBeGreaterThanOrEqual(2)
})

test('Rust reporting no material keeps the sidebar opaque', async ({ page }) => {
  // The setting went on and straight off again: Rust has stored the later
  // change already and answers the sync for the earlier one without the
  // effect, before the later change reaches this window.
  await stored(page, { sidebarMaterial: false })
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { sidebar_material_sync: false }
  })
  await page.goto('/')
  await expectShown(page, false)
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(1)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: true })
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(2)
  await expect(page.locator('.window')).toBeVisible()
  await expectShown(page, false)
  // The later change arrives and settles it.
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(3)
  await expectShown(page, false)
})

// Rust hands every page load the settings read at launch (the material on).
// A backup restore reloads the page after the material was turned off; the
// stored settings do not answer after the reload. A new load (a launch)
// starts from what Rust hands it.
for (const { load, shown } of [
  { load: 'reload', shown: 'off' },
  { load: 'new load', shown: 'on' },
] as const) {
  test(`after a ${load} the first paint shows the material ${shown}`, async ({ page }) => {
    await page.addInitScript(() => {
      const g = globalThis as unknown as TestWindow & {
        document: unknown
        sessionStorage: { getItem(key: string): string | null }
        MutationObserver: new (cb: () => void) => {
          observe(target: unknown, options: Record<string, unknown>): void
        }
        devotInitialEditorSettings: unknown
        devotShown: string[]
      }
      g.devotInitialEditorSettings = { revision: 0, settings: {} }
      g.devotShown = []
      new g.MutationObserver(() => {
        const html = (
          g.document as { documentElement: { getAttribute(name: string): string | null } }
        ).documentElement
        g.devotShown.push(html.getAttribute('data-sidebar-material') ?? '')
      }).observe(g.document, {
        attributes: true,
        subtree: true,
        attributeFilter: ['data-sidebar-material'],
      })
      if (g.sessionStorage.getItem('test.loaded') === '1')
        g.devotIpcMocks = { editor_settings_get: () => new Promise(() => {}) }
    })
    await page.goto('/')
    await expectShown(page, true)
    await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
    await expectShown(page, false)
    await page.evaluate(() =>
      (
        globalThis as unknown as { sessionStorage: { setItem(k: string, v: string): void } }
      ).sessionStorage.setItem('test.loaded', '1'),
    )
    if (load === 'reload') await page.reload()
    else await page.goto('/')
    await expectShown(page, shown === 'on')
    expect(
      await page.evaluate(() => (globalThis as unknown as { devotShown: string[] }).devotShown),
    ).toEqual([shown])
  })
}

test('a failed sync keeps the sidebar opaque', async ({ page }) => {
  await stored(page, { sidebarMaterial: false })
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { sidebar_material_sync: { error: 'E_SIDEBAR_MATERIAL_APPLY_FAILED' } }
  })
  await page.goto('/')
  await expectShown(page, false)
  // The stored settings turned it off once read: one sync so far.
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(1)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: true })
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(2)
  await expectShown(page, false)
})

test('another setting leaves the sidebar and the window effect alone', async ({ page }) => {
  await stored(page, { sidebarMaterial: false })
  await page.goto('/')
  await expectShown(page, false)
  await expect.poll(() => calls(page, 'sidebar_material_sync')).toHaveLength(1)
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false, lineNumbers: false })
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false, fontSize: 18 })
  await expect(page.locator('.window')).toBeVisible()
  await expectShown(page, false)
  expect(await calls(page, 'sidebar_material_sync')).toHaveLength(1)
})

test('stored settings without the material mean the default, the material', async ({ page }) => {
  await stored(page, { sidebarMaterial: false })
  await page.goto('/')
  await expectShown(page, false)
  await changeEditorSettingsElsewhere(page, { lineNumbers: false })
  await expectShown(page, true)
})

test('the Settings window turns the material off and on', async ({ page }) => {
  await openSettings(page, 'Appearance')
  await expect(appearance(page).getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await expect(translucent(page)).toBeChecked()
  await expect(translucent(page)).toHaveAccessibleDescription(/opaque sidebar/)

  await translucent(page).uncheck()
  await expect(translucent(page)).not.toBeChecked()
  await translucent(page).check()
  await expect(translucent(page)).toBeChecked()
  expect(await calls(page, 'editor_settings_set')).toEqual([
    { patch: { sidebarMaterial: false } },
    { patch: { sidebarMaterial: true } },
  ])
  // Only the main window brings the window effect in line.
  expect(await calls(page, 'sidebar_material_sync')).toHaveLength(0)
})

test('the Settings window shows the stored choice and changes from elsewhere', async ({ page }) => {
  await stored(page, { sidebarMaterial: false })
  await openSettings(page, 'Appearance')
  await expect(translucent(page)).not.toBeChecked()
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: true })
  await expect(translucent(page)).toBeChecked()
})

test('a change that cannot be stored is reported and dropped', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { editor_settings_set: { error: 'E_EDITOR_SETTINGS_WRITE_FAILED' } }
  })
  await openSettings(page, 'Appearance')
  // A click, not uncheck(): the box goes back as soon as Rust refuses.
  await translucent(page).click()
  await expect(appearance(page).getByRole('alert')).toContainText('E_EDITOR_SETTINGS_WRITE_FAILED')
  await expect(translucent(page)).toBeChecked()
})
