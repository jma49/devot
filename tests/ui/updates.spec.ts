import type { Page } from '@playwright/test'
import { expect, openApp, openSettings, test, type TestWindow } from './fixtures'

const IDLE = {
  revision: 0,
  current: '0.3.0-beta.1',
  enabled: true,
  askedBy: null,
  state: 'idle',
}

async function open(page: Page, mocks: Record<string, unknown> = {}) {
  await page.addInitScript((m) => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = m
  }, mocks)
  await openApp(page)
  // The window listens once it has started; sending earlier loses the status.
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
}

/** Sends a status as Rust's `devot://update-status` would reach the page. */
const sendStatus = (page: Page, status: Record<string, unknown>) =>
  page.evaluate((detail) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:update-status', { detail }))
  }, status)

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (globalThis as unknown as TestWindow).devotIpcCalls.filter((call) => call.cmd === c),
    cmd,
  )

test('offers Restart to Update once an update is downloaded', async ({ page }) => {
  await open(page, { update_status: IDLE, update_restart: null })
  const notice = page.locator('[data-devot-update]')
  await expect(notice).toHaveCount(0)
  await sendStatus(page, { ...IDLE, revision: 2, state: 'ready', version: '0.3.0-beta.2' })
  await expect(notice).toContainText('Devot 0.3.0-beta.2 is ready to install.')
  await notice.getByRole('button', { name: 'Restart to Update' }).click()
  await expect.poll(async () => (await calls(page, 'update_restart')).length).toBe(1)
})

test('Later hides the notice until there is a new update', async ({ page }) => {
  await open(page, { update_status: IDLE })
  const notice = page.locator('[data-devot-update]')
  await sendStatus(page, { ...IDLE, revision: 2, state: 'ready', version: '0.3.0-beta.2' })
  await notice.getByRole('button', { name: 'Later' }).click()
  await expect(notice).toHaveCount(0)
  // The same update again (a later revision) stays hidden.
  await sendStatus(page, { ...IDLE, revision: 3, state: 'ready', version: '0.3.0-beta.2' })
  await expect(notice).toHaveCount(0)
})

test('with auto download off, the notice offers a download', async ({ page }) => {
  await open(page, { update_status: IDLE, update_download: null })
  await sendStatus(page, { ...IDLE, revision: 1, state: 'available', version: '0.4.0-beta.1' })
  const notice = page.locator('[data-devot-update]')
  await expect(notice).toContainText('Devot 0.4.0-beta.1 is available.')
  await notice.getByRole('button', { name: 'Download' }).click()
  await expect.poll(async () => (await calls(page, 'update_download')).length).toBe(1)
})

test('the palette checks for updates, and the window reports its own check', async ({ page }) => {
  await open(page, { update_status: IDLE, update_check: null })
  await page.keyboard.press('Meta+KeyK')
  const field = page
    .getByRole('dialog', { name: 'Command Palette' })
    .getByRole('combobox', { name: 'Command Palette' })
  await field.fill('Check for Updates')
  await field.press('Enter')
  await expect.poll(async () => (await calls(page, 'update_check')).length).toBe(1)
  await sendStatus(page, { ...IDLE, revision: 1, askedBy: 'main', state: 'upToDate' })
  await expect(page.locator('[data-devot-update]')).toContainText(
    'Devot 0.3.0-beta.1 is the latest version.',
  )
  // A check asked for in Settings is reported there, not here.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await sendStatus(page, { ...IDLE, revision: 2, askedBy: 'settings', state: 'upToDate' })
  await expect(page.locator('[data-devot-update]')).toHaveCount(0)
})

test('Settings > General turns automatic downloads off and checks now', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      update_status: {
        revision: 0,
        current: '0.3.0-beta.1',
        enabled: true,
        askedBy: null,
        state: 'idle',
      },
      update_check: null,
    }
  })
  await openSettings(page, 'General')
  const general = page.getByRole('region', { name: 'General', exact: true })
  const toggle = general.getByRole('switch', { name: 'Automatically Download Updates' })
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(
        () => (globalThis as unknown as TestWindow).devotEditorSettings?.['autoDownloadUpdates'],
      ),
    )
    .toBe(false)
  await expect(general).toContainText('Devot 0.3.0-beta.1.')
  await general.getByRole('button', { name: 'Check Now' }).click()
  await expect.poll(async () => (await calls(page, 'update_check')).length).toBe(1)
})

test('Later on an available update stays until a newer one', async ({ page }) => {
  await open(page, { update_status: IDLE })
  const notice = page.locator('[data-devot-update]')
  await sendStatus(page, { ...IDLE, revision: 1, state: 'available', version: '0.4.0-beta.1' })
  await notice.getByRole('button', { name: 'Later' }).click()
  await expect(notice).toHaveCount(0)
  // The next daily check finds the same version again.
  await sendStatus(page, { ...IDLE, revision: 3, state: 'available', version: '0.4.0-beta.1' })
  await expect(notice).toHaveCount(0)
  await sendStatus(page, { ...IDLE, revision: 5, state: 'available', version: '0.4.0-beta.2' })
  await expect(notice).toContainText('Devot 0.4.0-beta.2 is available.')
})
