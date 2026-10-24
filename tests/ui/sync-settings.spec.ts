import type { Page } from '@playwright/test'
import { expect, openApp, openSettings, test, type TestWindow } from './fixtures'

// Settings > Sync, and the main window's notice. Rust is faked in the page: it keeps the relay's
// URL and whether sync is on, and says only whether a vault and a token are there, as the real
// commands do; the relay's secret goes in and is never read back.

const RELAY = 'https://relay.example.test'
const SECRET = 'relay-secret-0123456789abcdef0123456789'

interface FakeSync {
  relayUrl?: string
  enabled?: boolean
  enrolled?: boolean
  status?: Record<string, unknown>
  /** What the vault's creation fails with. */
  refuse?: string
}

async function fakeRust(page: Page, initial: FakeSync = {}) {
  await page.addInitScript((start: FakeSync) => {
    const w = globalThis as unknown as TestWindow
    const state = {
      relayUrl: start.relayUrl ?? '',
      enabled: start.enabled ?? false,
      vault: start.enrolled ?? false,
      enrolled: start.enrolled ?? false,
      status: { state: 'off', lastSync: null, code: null, tooLarge: 0, ...start.status },
    }
    const copy = () => JSON.parse(JSON.stringify(state))
    w.devotIpcMocks = {
      sync_get: () => copy(),
      sync_set: (args: { patch: { relayUrl?: string; enabled?: boolean } }) => {
        const { relayUrl, enabled } = args.patch
        if (relayUrl !== undefined) {
          if (relayUrl !== '' && !relayUrl.startsWith('https://')) throw 'E_SYNC_RELAY_URL_INVALID'
          state.relayUrl = relayUrl
          state.enrolled = false
        }
        if (enabled !== undefined) state.enabled = enabled
        return copy()
      },
      sync_vault_create: (args: { relaySecret: string }) => {
        if (start.refuse) throw start.refuse
        if (!args.relaySecret) throw 'E_SYNC_RELAY_SECRET_INVALID'
        state.vault = true
        state.enrolled = true
        state.enabled = true
        return copy()
      },
    }
  }, initial)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

const sendSnapshot = (page: Page, snapshot: Record<string, unknown>) =>
  page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('devot:sync-changed', { detail }))
  }, snapshot)

test('starts off, with no relay', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('encrypted on this device before it leaves')
  await expect(panel.getByRole('textbox', { name: 'Relay' })).toHaveValue('')
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeDisabled()
  await expect(panel).toContainText('Off. Not synced yet.')
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
})

test('creates the vault with the relay’s secret, asked once and never kept', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const relay = panel.getByRole('textbox', { name: 'Relay' })
  await relay.fill(RELAY)
  await relay.press('Enter')
  expect(await calls(page, 'sync_set')).toEqual([{ patch: { relayUrl: RELAY } }])
  const secret = panel.getByLabel('Relay Secret')
  await expect(secret).toHaveAttribute('type', 'password')
  const create = panel.getByRole('button', { name: 'Create Vault' })
  await expect(create).toBeDisabled()
  await secret.fill(SECRET)
  await create.click()
  await expect(panel.getByRole('status')).toHaveText('The vault is ready and sync is on.')
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeChecked()
  expect(await calls(page, 'sync_vault_create')).toEqual([{ relaySecret: SECRET }])
  const others = await page.evaluate(
    (s) =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd !== 'sync_vault_create' && JSON.stringify(c.args ?? {}).includes(s),
      ).length,
    SECRET,
  )
  expect(others).toBe(0)
})

test('asks for the relay’s secret again when the relay lost the vault', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeChecked()
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  // Rust drops the token when the relay answers E_SYNC_NO_VAULT; the key stays.
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: false,
    status: { state: 'stopped', lastSync: 1, code: 'E_SYNC_NO_VAULT', tooLarge: 0 },
  })
  await expect(panel).toContainText('This device holds a vault the relay does not know.')
  await panel.getByLabel('Relay Secret').fill(SECRET)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  expect(await calls(page, 'sync_vault_create')).toEqual([{ relaySecret: SECRET }])
})

test('says why the relay address or the vault was refused', async ({ page }) => {
  await fakeRust(page, { refuse: 'E_SYNC_RELAY_SECRET' })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const relay = panel.getByRole('textbox', { name: 'Relay' })
  await relay.fill('http://relay.example.test')
  await relay.blur()
  await expect(panel.getByRole('alert')).toHaveText(
    'The relay address could not be saved (E_SYNC_RELAY_URL_INVALID).',
  )
  await relay.fill(RELAY)
  await relay.blur()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByLabel('Relay Secret').fill('wrong')
  await panel.getByRole('button', { name: 'Create Vault' }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    'The vault could not be created (E_SYNC_RELAY_SECRET).',
  )
  await expect(panel.getByLabel('Relay Secret')).toHaveValue('wrong')
})

test('turns sync off and on, and shows the status Rust reports', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    status: { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 12) },
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('Up to date. Last synced')
  const toggle = panel.getByRole('switch', { name: 'Sync This Device' })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  expect(await calls(page, 'sync_set')).toEqual([{ patch: { enabled: false } }])
  await toggle.click()
  await expect(toggle).toBeChecked()
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: true,
    status: { state: 'stopped', lastSync: null, code: 'E_SYNC_REVOKED', tooLarge: 2 },
  })
  await expect(panel).toContainText('Stopped. Code E_SYNC_REVOKED. Not synced yet.')
  await expect(panel).toContainText('2 notes are too large for the relay and stay on this device.')
})

test('the main window says when this device was removed from sync', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    status: { state: 'stopped', code: 'E_SYNC_REVOKED' },
  })
  await openApp(page)
  const notice = page.getByRole('alert').filter({ hasText: 'removed from sync' })
  await expect(notice).toHaveText(/This device was removed from sync, so sync has stopped/)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: true,
    status: { state: 'idle', lastSync: 1, code: null, tooLarge: 1 },
  })
  await expect(page.getByRole('alert').filter({ hasText: 'too large' })).toHaveText(
    /1 note is too large to sync and stays on this device only\./,
  )
})
