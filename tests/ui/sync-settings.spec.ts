import type { Locator, Page } from '@playwright/test'
import { clipboardWrites, expect, openApp, openSettings, test, type TestWindow } from './fixtures'

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
  /** What joining fails with. */
  refuseJoin?: string
  /** What removing a device fails with. */
  refuseRemove?: string
  /** How long removing a device takes, in milliseconds. */
  removeDelay?: number
  devices?: { id: string; label: string; created: number; current: boolean }[]
}

const RECOVERY_KEY =
  '0400Y-2E8Q3-5G2CA-1DPKB-NHGQ0-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK-MMMMM-N'
const CODE = '0400-E3GN-3GHJ-MC9R-7X34-TN2V-C9MN-JTDF'
const NOW = Date.UTC(2026, 9, 26, 12)

async function fakeRust(page: Page, initial: FakeSync = {}) {
  await page.addInitScript(
    ({ start, recoveryKey, code, now }) => {
      const w = globalThis as unknown as TestWindow & {
        devotPairing?: string
        devotPairingFails?: string
        /** What listing the devices fails with. */
        devotDevicesFails?: string
        /** A device enrolled with the code on show but never confirmed. */
        devotStrangerEnrolled?: boolean
      }
      const state = {
        relayUrl: start.relayUrl ?? '',
        enabled: start.enabled ?? false,
        vault: start.enrolled ?? false,
        enrolled: start.enrolled ?? false,
        status: { state: 'off', lastSync: null, code: null, tooLarge: 0, ...start.status },
      }
      let devices = start.devices ?? [
        { id: 'mac', label: 'Devot for macOS', created: now - 86_400_000, current: true },
        { id: 'phone', label: 'Devot for iOS', created: now, current: false },
      ]
      const stranger = { id: 'stranger', label: 'Devot for iOS', created: now, current: false }
      let recoveryPending = false
      const copy = () => JSON.parse(JSON.stringify(state))
      const joined = () => {
        if (start.refuseJoin) throw start.refuseJoin
        state.vault = true
        state.enrolled = true
        state.enabled = true
        return copy()
      }
      w.devotPairing = 'waiting'
      w.devotIpcMocks = {
        sync_get: () => copy(),
        sync_set: (args: { patch: { relayUrl?: string; enabled?: boolean } }) => {
          const { relayUrl, enabled } = args.patch
          if (relayUrl !== undefined) {
            if (relayUrl !== '' && !relayUrl.startsWith('https://'))
              throw 'E_SYNC_RELAY_URL_INVALID'
            state.relayUrl = relayUrl
            state.enrolled = false
          }
          if (enabled !== undefined) state.enabled = enabled
          return copy()
        },
        sync_vault_create: (args: { relaySecret: string }) => {
          if (start.refuse) throw start.refuse
          if (!args.relaySecret) throw 'E_SYNC_RELAY_SECRET_INVALID'
          if (!state.vault) recoveryPending = true
          state.vault = true
          state.enrolled = true
          state.enabled = true
          return { snapshot: copy(), recoveryKey: recoveryPending ? recoveryKey : null }
        },
        sync_recovery_key: () => (recoveryPending && state.enrolled ? recoveryKey : null),
        sync_recovery_saved: () => {
          recoveryPending = false
          return null
        },
        sync_join_code: () => joined(),
        sync_join_recovery: () => joined(),
        sync_pairing_open: () => ({
          code,
          link: `devot://pair?relay=https%3A%2F%2Frelay.example.test&code=${code.replace(/-/g, '')}`,
          qr: { size: 21, modules: '10'.repeat(220) + '1' },
          expires: Date.now() + 600_000,
        }),
        sync_pairing_check: () => {
          if (w.devotPairingFails) throw w.devotPairingFails
          if (w.devotPairing === 'paired') {
            devices = [
              ...devices,
              {
                id: `tablet-${devices.length}`,
                label: 'Devot for iOS',
                created: now,
                current: false,
              },
            ]
            w.devotPairing = 'done'
            return { state: 'paired', device: 'tablet' }
          }
          return { state: w.devotPairing, device: null }
        },
        sync_pairing_cancel: () => null,
        sync_devices: () => {
          if (w.devotDevicesFails) throw w.devotDevicesFails
          return w.devotStrangerEnrolled ? [...devices, stranger] : devices
        },
        sync_device_remove: async (args: { device: string }) => {
          await new Promise((done) => setTimeout(done, start.removeDelay ?? 0))
          if (start.refuseRemove) throw start.refuseRemove
          devices = devices.filter((d) => d.id !== args.device)
          return devices
        },
      }
    },
    { start: initial, recoveryKey: RECOVERY_KEY, code: CODE, now: NOW },
  )
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

const pairingCode = (panel: Locator) =>
  panel.getByRole('group', { name: 'Pairing code' }).locator('.pairing-code')

const recoveryKey = (panel: Locator) =>
  panel.getByRole('group', { name: 'Recovery Key', exact: true }).locator('pre')

const sendSnapshot = (page: Page, snapshot: Record<string, unknown>) =>
  page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('devot:sync-changed', { detail }))
  }, snapshot)

test('starts off, with no relay', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('encrypted on this device before it leaves')
  await expect(panel).toContainText('notes, notebooks, tags and images')
  // One plain question first; no relay field, code field or vault button until it is answered.
  await expect(panel).toContainText('Is this the first device you are syncing')
  await expect(panel.getByRole('button', { name: 'This Is My First Device' })).toBeEnabled()
  await expect(panel.getByRole('button', { name: 'I’m Adding Another Device' })).toBeEnabled()
  await expect(panel.getByRole('textbox', { name: 'Relay' })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toHaveCount(0)
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeDisabled()
  await expect(panel).toContainText('Off. Not synced yet.')
})

test('shows only the first-device path, and no way to join, after the first answer', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'This Is My First Device' }).click()
  await expect(panel.getByRole('textbox', { name: 'Relay' })).toBeFocused()
  await expect(panel.getByRole('button', { name: 'I’m Adding Another Device' })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toHaveCount(0)
  await expect(panel.getByRole('textbox', { name: 'Join With Recovery Key' })).toHaveCount(0)
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
})

test('shows only the join path, and no way to make a vault, after the second answer', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toBeFocused()
  await expect(panel.getByRole('textbox', { name: 'Join With Recovery Key' })).toBeVisible()
  await expect(panel.getByRole('textbox', { name: 'Relay' })).toBeVisible()
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Create Vault' })).toHaveCount(0)
  // Even with a relay set, this path never offers a second vault.
  await panel.getByRole('textbox', { name: 'Relay' }).fill(RELAY)
  await panel.getByRole('textbox', { name: 'Relay' }).press('Enter')
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'This Is My First Device' })).toHaveCount(0)
  // Changing the answer goes back to the question.
  await panel.getByRole('button', { name: 'Change Answer' }).click()
  await expect(panel.getByRole('button', { name: 'This Is My First Device' })).toBeFocused()
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toHaveCount(0)
})

test('creates the vault with the relay’s secret, asked once and never kept', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'This Is My First Device' }).click()
  const relay = panel.getByRole('textbox', { name: 'Relay' })
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await relay.fill(RELAY)
  await relay.press('Enter')
  expect(await calls(page, 'sync_set')).toEqual([{ patch: { relayUrl: RELAY } }])
  const secret = panel.getByLabel('Relay Secret')
  await expect(secret).toHaveAttribute('type', 'password')
  const create = panel.getByRole('button', { name: 'Create Vault' })
  await expect(create).toBeDisabled()
  await secret.fill(SECRET)
  await create.click()
  await expect(panel.getByRole('status').first()).toHaveText('The vault is ready and sync is on.')
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  // The recovery key until it is saved, with Copy, which puts it on the clipboard as a secret.
  const key = recoveryKey(panel)
  await expect(key).toHaveText(RECOVERY_KEY)
  await expect(key).toBeFocused()
  await expect(panel.locator('pre[aria-label]')).toHaveCount(0)
  await expect(panel).toContainText('Once you say you saved it, Devot does not show it again.')
  await panel.getByRole('button', { name: 'Copy' }).click()
  await expect(panel.getByRole('status').first()).toHaveText(
    'The recovery key was copied. It leaves the clipboard after 90 seconds.',
  )
  expect(await calls(page, 'clipboard_write_secret')).toEqual([{ text: RECOVERY_KEY }])
  expect(await clipboardWrites(page)).toEqual([])
  await panel.getByRole('button', { name: 'I Saved It' }).click()
  await expect(key).toHaveCount(0)
  expect(await calls(page, 'sync_recovery_saved')).toHaveLength(1)
  await expect(panel.getByRole('button', { name: 'Show Pairing Code' })).toBeFocused()
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

test('backs out of setting up a new vault with Cancel or Escape', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const start = panel.getByRole('button', { name: 'This Is My First Device' })
  const secret = panel.getByLabel('Relay Secret')
  await start.click()
  await secret.fill(SECRET)
  await secret.press('Escape')
  await expect(secret).toHaveCount(0)
  await expect(start).toBeFocused()

  await start.click()
  await expect(secret).toHaveValue('')
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(secret).toHaveCount(0)
  await expect(start).toBeFocused()
  expect(await calls(page, 'sync_vault_create')).toEqual([])
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
  await panel.getByRole('button', { name: 'This Is My First Device' }).click()
  const relay = panel.getByRole('textbox', { name: 'Relay' })
  await relay.fill('http://relay.example.test')
  await relay.blur()
  await expect(panel.getByRole('alert')).toHaveText(
    'The relay address could not be saved (E_SYNC_RELAY_URL_INVALID). A relay’s address starts with https:// (http:// only for a relay on this computer).',
  )
  await relay.fill(RELAY)
  await relay.blur()
  await expect(panel.getByRole('alert')).toHaveCount(0)
  await panel.getByLabel('Relay Secret').fill('wrong')
  await panel.getByRole('button', { name: 'Create Vault' }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    'The vault could not be created (E_SYNC_RELAY_SECRET). The relay did not accept that secret. Check RELAY_SECRET on the relay.',
  )
  await expect(panel.getByLabel('Relay Secret')).toHaveValue('wrong')
})

const REFUSALS: Readonly<Record<string, string>> = {
  E_SYNC_RELAY_SECRET_INVALID: 'The relay’s secret is empty or holds characters it cannot.',
  E_SYNC_OFFLINE: 'The relay could not be reached, or it answered with an error.',
  E_SYNC_RELAY_FAILED: 'The relay could not be reached, or it answered with an error.',
  E_SYNC_KEYCHAIN: 'The keychain did not let Devot keep this vault’s key.',
  E_SYNC_KEYCHAIN_UNAVAILABLE: 'The keychain did not let Devot keep this vault’s key.',
  E_SYNC_TOO_MANY_DEVICES: 'The vault is at its device limit. Remove a device you no longer use',
  E_SYNC_ENROLL_DENIED: 'The relay refused this device: the key or code belongs to another vault.',
}

for (const [code, advice] of Object.entries(REFUSALS)) {
  test(`says what to do when creating the vault fails with ${code}`, async ({ page }) => {
    await fakeRust(page, { relayUrl: RELAY, refuse: code })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await panel.getByRole('button', { name: 'This Is My First Device' }).click()
    await panel.getByLabel('Relay Secret').fill('secret')
    await panel.getByRole('button', { name: 'Create Vault' }).click()
    await expect(panel.getByRole('alert')).toContainText(`(${code}). ${advice}`)
  })
}

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

test('says when changes from another device could not be read', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    status: { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 12), skipped: 1 },
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText(
    '1 change from another device could not be read and was skipped. Update Devot',
  )
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: true,
    status: { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 12), skipped: 3 },
  })
  await expect(panel).toContainText('3 changes from other devices could not be read')
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: true,
    status: { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 12) },
  })
  await expect(panel).not.toContainText('could not be read')
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

test('a dismissed clock notice stays away while sync only rechecks the clock', async ({ page }) => {
  const snapshot = { relayUrl: RELAY, enabled: true, vault: true, enrolled: true }
  const stopped = { state: 'stopped', lastSync: 1, code: 'E_SYNC_CLOCK_SKEW', tooLarge: 0 }
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: stopped })
  await openApp(page)
  const notice = page.getByRole('alert').filter({ hasText: 'clock is more than 5 minutes off' })
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, state: 'connecting' } })
  await sendSnapshot(page, { ...snapshot, status: stopped })
  await expect(notice).toHaveCount(0)
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, state: 'idle', code: null } })
  await sendSnapshot(page, { ...snapshot, status: stopped })
  await expect(notice).toHaveCount(1)
})

test('a dismissed clock notice stays away while notes too large are rechecked', async ({
  page,
}) => {
  const snapshot = { relayUrl: RELAY, enabled: true, vault: true, enrolled: true }
  const stopped = { state: 'stopped', lastSync: 1, code: 'E_SYNC_CLOCK_SKEW', tooLarge: 2 }
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: stopped })
  await openApp(page)
  const notice = page.getByRole('alert').filter({ hasText: 'too large' })
  await expect(notice).toHaveCount(1)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, state: 'connecting' } })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, state: 'syncing' } })
  await expect(page.getByRole('alert')).toHaveCount(0)
  await sendSnapshot(page, { ...snapshot, status: stopped })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('says what to do when sync stopped for the protocol or the loop breaker', async ({ page }) => {
  const snapshot = { relayUrl: RELAY, enabled: true, vault: true, enrolled: true }
  const stopped = { state: 'stopped', lastSync: 1, tooLarge: 0 }
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    status: { ...stopped, code: 'E_SYNC_PROTOCOL' },
  })
  await openApp(page)
  const notice = page.getByRole('alert').filter({ hasText: 'Sync has stopped' })
  await expect(notice).toHaveText(
    /Sync has stopped \(E_SYNC_PROTOCOL\)\. Update Devot and your relay to the same release\./,
  )
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, code: 'E_SYNC_CIRCUIT_OPEN' } })
  await expect(notice).toContainText('Turn Sync This Device off and on in Settings > Sync')
  await sendSnapshot(page, { ...snapshot, status: { ...stopped, code: 'E_SYNC_NO_VAULT_KEY' } })
  await expect(notice).toContainText('turn Sync This Device off and on to try again')
})

test('Settings > Sync says what to do when sync stopped for the protocol', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    status: { state: 'stopped', lastSync: null, code: 'E_SYNC_PROTOCOL', tooLarge: 0 },
  })
  await openSettings(page, 'Sync')
  await expect(page.getByRole('tabpanel')).toContainText(
    'Stopped. Update Devot and your relay to the same release. Code E_SYNC_PROTOCOL.',
  )
})

test('asks for no recovery key again when the vault was already there', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: false,
    status: { state: 'stopped', lastSync: 1, code: 'E_SYNC_NO_VAULT', tooLarge: 0 },
  })
  await panel.getByLabel('Relay Secret').fill(SECRET)
  await panel.getByRole('button', { name: 'Connect' }).click()
  await expect(panel.getByLabel('Relay Secret')).toHaveCount(0)
  await expect(recoveryKey(panel)).toHaveCount(0)
})

test('joins a vault with a pairing code', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  const code = panel.getByRole('textbox', { name: 'Join With a Code' })
  const join = panel.getByRole('button', { name: 'Join With a Code' })
  await expect(join).toBeDisabled()
  await code.fill(CODE.toLowerCase())
  await join.click()
  await expect(panel.getByRole('status').first()).toHaveText(
    'This device joined the vault and sync is on.',
  )
  expect(await calls(page, 'sync_join_code')).toEqual([{ code: CODE.toLowerCase() }])
  await expect(code).toHaveCount(0)
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeChecked()
  await expect(panel.getByRole('button', { name: 'Show Pairing Code' })).toBeFocused()
})

test('asks before a pasted link sets the relay it names', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  const link = `devot://pair?relay=${encodeURIComponent(RELAY)}&code=${CODE.replace(/-/g, '')}`
  await panel.getByRole('textbox', { name: 'Join With a Code' }).fill(link)
  await panel.getByRole('button', { name: 'Join With a Code' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Sync through the relay at relay.example.test?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(await calls(page, 'sync_set')).toEqual([])
  expect(await calls(page, 'sync_join_code')).toEqual([])

  await panel.getByRole('button', { name: 'Join With a Code' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Use This Relay' }).click()
  await expect(panel.getByRole('status').first()).toHaveText(
    'This device joined the vault and sync is on.',
  )
  expect(await calls(page, 'sync_set')).toEqual([{ patch: { relayUrl: RELAY } }])
  expect(await calls(page, 'sync_join_code')).toEqual([{ code: link }])
})

test('refuses a pasted link to a relay Devot cannot use, without asking first', async ({
  page,
}) => {
  await fakeRust(page)
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  const link = `devot://pair?relay=${encodeURIComponent('http://relay.example.test')}&code=${CODE.replace(/-/g, '')}`
  await panel.getByRole('textbox', { name: 'Join With a Code' }).fill(link)
  await panel.getByRole('button', { name: 'Join With a Code' }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    'This device could not join the vault (E_SYNC_RELAY_URL_INVALID). A relay’s address starts with https:// (http:// only for a relay on this computer).',
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await calls(page, 'sync_set')).toEqual([])
  expect(await calls(page, 'sync_join_code')).toEqual([])
})

test('joins with the recovery key and the relay set above', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  const key = panel.getByRole('textbox', { name: 'Join With Recovery Key' })
  await key.fill(RECOVERY_KEY)
  await key.press('Enter')
  await expect(panel.getByRole('status').first()).toHaveText(
    'This device joined the vault and sync is on.',
  )
  expect(await calls(page, 'sync_join_recovery')).toEqual([{ recoveryKey: RECOVERY_KEY }])
  await expect(key).toHaveCount(0)
})

test('says why joining failed, and that an older relay needs an update', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, refuseJoin: 'E_SYNC_RELAY_OUTDATED' })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  await panel.getByRole('textbox', { name: 'Join With a Code' }).fill(CODE)
  await panel.getByRole('button', { name: 'Join With a Code' }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    'This device could not join the vault (E_SYNC_RELAY_OUTDATED). Your relay is from before pairing: update it (docs/sync-relay.md, Update the relay). The recovery key works with it meanwhile.',
  )
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toHaveValue(CODE)
})

test('shows a pairing code with its QR code and countdown until a device joins', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('textbox', { name: 'Join With a Code' })).toHaveCount(0)
  const devices = panel.getByRole('list', { name: 'Devices in this vault' })
  await expect(devices.getByRole('listitem')).toHaveCount(2)
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await expect(panel.getByRole('img', { name: 'QR code for pairing a device' })).toBeVisible()
  await expect(pairingCode(panel)).toHaveText(CODE)
  await expect(pairingCode(panel)).toBeFocused()
  await expect(panel.locator('p[aria-label]')).toHaveCount(0)
  const label = await panel.getByText('Add a Device', { exact: true }).boundingBox()
  const qr = await panel.getByRole('img', { name: 'QR code for pairing a device' }).boundingBox()
  expect(Math.abs(label!.y - qr!.y)).toBeLessThan(24)
  // The countdown sits outside the live region, which speaks only when the progress changes.
  const progress = panel.locator('.pairing').getByRole('status')
  await expect(progress).toHaveText('Waiting for the other device…')
  await expect(panel.locator('.pairing')).toContainText(/Expires in (10:00|9:5\d)\./)
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'taken'
  })
  await expect(panel).toContainText('A device is joining…')
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'paired'
  })
  await expect(panel.getByRole('status').first()).toHaveText('A new device joined the vault.')
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(devices.getByRole('listitem')).toHaveCount(3)
})

test('cancels a code on show, and says when it expired', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const show = panel.getByRole('button', { name: 'Show Pairing Code' })
  await show.click()
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(show).toBeFocused()
  expect(await calls(page, 'sync_pairing_cancel')).toHaveLength(1)

  await show.click()
  await expect(pairingCode(panel)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(show).toBeFocused()
  expect(await calls(page, 'sync_pairing_cancel')).toHaveLength(2)

  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'expired'
  })
  await show.click()
  await expect(panel).toContainText('The code expired. Show a new one to try again.')
  await expect(panel.getByRole('status').first()).toHaveText(
    'The code expired. Show a new one to try again.',
  )
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(show).toBeFocused()
})

test('warns when a device took the code and never finished joining, and lists it', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await page.evaluate(() => {
    const w = globalThis as unknown as { devotPairing: string; devotStrangerEnrolled: boolean }
    w.devotStrangerEnrolled = true
    w.devotPairing = 'unconfirmed'
  })
  await expect(panel.getByRole('status').first()).toHaveText(
    /A device took this code but did not finish joining\..*check Devices/,
  )
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(items).toHaveCount(3)
})

test('keeps polling while the relay is out of reach, and closes the code when the pairing fails', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const fail = (code: string | undefined) =>
    page.evaluate((c) => {
      ;(globalThis as unknown as { devotPairingFails?: string | undefined }).devotPairingFails = c
    }, code)
  await fail('E_SYNC_OFFLINE')
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await expect(panel).toContainText('Cannot reach the relay. Trying again…')
  await expect(pairingCode(panel)).toHaveText(CODE)
  await fail(undefined)
  await expect(panel.locator('.pairing').getByRole('status')).toHaveText(
    'Waiting for the other device…',
  )
  expect(await calls(page, 'sync_pairing_cancel')).toEqual([])

  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  // The device that took the code may have enrolled before its confirmation failed to open.
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotStrangerEnrolled: boolean }).devotStrangerEnrolled = true
  })
  await fail('E_SYNC_PAIRING_AUTH')
  await expect(panel.getByRole('alert')).toHaveText(
    /^The pairing stopped \(E_SYNC_PAIRING_AUTH\)\./,
  )
  await expect(pairingCode(panel)).toHaveCount(0)
  expect(await calls(page, 'sync_pairing_cancel')).toHaveLength(1)
  await expect(items).toHaveCount(3)
})

test('keeps the recovery key on offer across a pane switch until it is saved', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'This Is My First Device' }).click()
  await panel.getByLabel('Relay Secret').fill(SECRET)
  await panel.getByRole('button', { name: 'Create Vault' }).click()
  const key = recoveryKey(panel)
  await expect(key).toHaveText(RECOVERY_KEY)
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.getByRole('tab', { name: 'Sync', exact: true }).click()
  await expect(key).toHaveText(RECOVERY_KEY)
  await panel.getByRole('button', { name: 'I Saved It' }).click()
  await expect(key).toHaveCount(0)
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.getByRole('tab', { name: 'Sync', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Show Pairing Code' })).toBeVisible()
  await expect(key).toHaveCount(0)
})

test('the recovery key fits a narrow Settings window, with its buttons in reach', async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 640 })
  await fakeRust(page, { relayUrl: RELAY })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'This Is My First Device' }).click()
  await panel.getByLabel('Relay Secret').fill(SECRET)
  await panel.getByRole('button', { name: 'Create Vault' }).click()
  const key = recoveryKey(panel)
  await expect(key).toBeVisible()
  const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const box = await panel.boundingBox()
  for (const target of [
    key,
    panel.getByRole('button', { name: 'Copy' }),
    panel.getByRole('button', { name: 'I Saved It' }),
  ]) {
    const b = await target.boundingBox()
    expect(b).not.toBeNull()
    expect(b!.x).toBeGreaterThanOrEqual(box!.x)
    expect(b!.x + b!.width).toBeLessThanOrEqual(box!.x + box!.width)
  }
})

test('brings a failure from a row far down the section into view', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 640 })
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    refuseRemove: 'E_SYNC_OFFLINE',
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: /^Remove Devot for iOS/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(panel.getByRole('alert')).toHaveText(
    /^The device could not be removed \(E_SYNC_OFFLINE\)\. The relay could not be reached/,
  )
  await expect(panel.getByRole('alert')).toBeInViewport()
})

test('lists the devices with this one marked, and removes another after asking', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const devices = panel.getByRole('list', { name: 'Devices in this vault' })
  const items = devices.getByRole('listitem')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('Devot for macOS')
  await expect(items.first()).toContainText('This Device')
  await expect(items.first().getByRole('button')).toHaveCount(0)
  await expect(items.nth(1)).not.toContainText('This Device')

  await items
    .nth(1)
    .getByRole('button', { name: /^Remove Devot for iOS, added / })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(
    /Remove Devot for iOS, added [A-Z][a-z]{2} \d+, 2026, from sync\?/,
  )
  await expect(dialog).not.toContainText('this device')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(items).toHaveCount(2)
  expect(await calls(page, 'sync_device_remove')).toEqual([])

  await items
    .nth(1)
    .getByRole('button', { name: /^Remove / })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(items).toHaveCount(1)
  await expect(panel.getByRole('status').first()).toHaveText('The device was removed from sync.')
  expect(await calls(page, 'sync_device_remove')).toEqual([{ device: 'phone' }])
  await expect(devices).toBeFocused()
})

test('removes a device once, with its button off until the relay answers, and keeps focus on the list', async ({
  page,
}) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    removeDelay: 1_000,
    devices: [
      { id: 'mac', label: 'Devot for macOS', created: NOW - 86_400_000, current: true },
      { id: 'phone', label: 'Devot for iOS', created: NOW, current: false },
      { id: 'tablet', label: 'Devot for iOS', created: NOW + 60_000, current: false },
    ],
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  const remove = items.nth(1).getByRole('button', { name: /^Remove / })
  await remove.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(remove).toBeDisabled()
  await remove.click({ force: true })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(items).toHaveCount(2)
  expect(await calls(page, 'sync_device_remove')).toEqual([{ device: 'phone' }])
  await expect(items.nth(1).getByRole('button', { name: /^Remove / })).toBeFocused()
})

test('a pairing that ends leaves an open Remove dialog open', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await expect(pairingCode(panel)).toHaveText(CODE)
  await items
    .nth(1)
    .getByRole('button', { name: /^Remove / })
    .click()
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'paired'
  })
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(items).toHaveCount(3)
  await expect(page.getByRole('dialog')).toContainText('from sync?')
})

test('a pairing that ends does not re-enable the Remove button of a removal in flight', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, removeDelay: 5_000 })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await items
    .nth(1)
    .getByRole('button', { name: /^Remove / })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'paired'
  })
  await expect(items).toHaveCount(3)
  await expect(items.nth(1).getByRole('button', { name: /^Remove / })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(items).toHaveCount(2, { timeout: 10_000 })
  await expect(panel.getByRole('status').first()).toHaveText('The device was removed from sync.')
  expect(await calls(page, 'sync_device_remove')).toEqual([{ device: 'phone' }])
})

test('lists the devices again with Try Again when the relay was out of reach', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as { devotDevicesFails: string }).devotDevicesFails = 'E_SYNC_OFFLINE'
  })
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel).toContainText('The devices could not be listed (E_SYNC_OFFLINE).')
  await expect(panel.getByRole('listitem')).toHaveCount(0)
  await page.evaluate(() => {
    delete (globalThis as unknown as { devotDevicesFails?: string }).devotDevicesFails
  })
  await panel.getByRole('button', { name: 'Try Again' }).click()
  await expect(panel.getByRole('list', { name: 'Devices in this vault' })).toBeVisible()
  await expect(panel).not.toContainText('could not be listed')
  await expect(panel.getByRole('button', { name: 'Try Again' })).toHaveCount(0)
})

test('Try Again says when the listing fails again, and hands focus to the list when it works', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as { devotDevicesFails: string }).devotDevicesFails = 'E_SYNC_OFFLINE'
  })
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  const retry = panel.getByRole('button', { name: 'Try Again' })
  await expect(retry).toBeVisible()
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('status').first()).toHaveText(
    'The devices could not be listed (E_SYNC_OFFLINE).',
  )
  await page.evaluate(() => {
    delete (globalThis as unknown as { devotDevicesFails?: string }).devotDevicesFails
  })
  await retry.focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByRole('list', { name: 'Devices in this vault' })).toBeFocused()
})

test('a device name with no spaces wraps inside the Remove dialog', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    devices: [
      { id: 'mac', label: 'Devot for macOS', created: NOW, current: true },
      { id: 'phone', label: 'w'.repeat(200), created: NOW, current: false },
    ],
  })
  await openSettings(page, 'Sync')
  await page
    .getByRole('tabpanel')
    .getByRole('button', { name: /^Remove w+, added / })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Remove www')
  const { scroll, client } = await dialog.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
  }))
  expect(scroll).toBeLessThanOrEqual(client)
})

test('a device removed from the vault is told so, and that the relay’s secret signs it back in', async ({
  page,
}) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('switch', { name: 'Sync This Device' })).toBeChecked()
  await sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: false,
    status: { state: 'stopped', lastSync: 1, code: 'E_SYNC_REVOKED', tooLarge: 0 },
  })
  await expect(panel).toContainText('This device was removed from the vault.')
  await expect(panel).toContainText('Enter the relay’s secret once to sign it back in')
  await expect(panel).not.toContainText('does not know')
})

test('a pairing that ends on its own leaves focus where the person put it', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await expect(pairingCode(panel)).toBeFocused()
  const relay = panel.getByRole('textbox', { name: 'Relay', exact: true })
  await relay.focus()
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotPairing: string }).devotPairing = 'expired'
  })
  await expect(pairingCode(panel)).toHaveCount(0)
  await expect(relay).toBeFocused()
})

test('announces the same failure or confirmation again', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: false,
    refuseJoin: 'E_SYNC_PAIRING_CODE',
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'I’m Adding Another Device' }).click()
  await page.evaluate(() => {
    const w = globalThis as unknown as { alertsAdded: number }
    w.alertsAdded = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.getAttribute('role') === 'alert') w.alertsAdded++
    }).observe(document.body, { subtree: true, childList: true })
  })
  await panel.getByRole('textbox', { name: 'Join With a Code' }).fill(CODE)
  const join = panel.getByRole('button', { name: 'Join With a Code' })
  await join.click()
  await expect(panel.getByRole('alert')).toContainText('could not join the vault')
  await join.click()
  await expect
    .poll(() => page.evaluate(() => (globalThis as { alertsAdded?: number }).alertsAdded))
    .toBe(2)
})

test('says again that a second device was removed', async ({ page }) => {
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    devices: [
      { id: 'mac', label: 'Devot for macOS', created: NOW - 86_400_000, current: true },
      { id: 'phone', label: 'Devot for iOS', created: NOW, current: false },
      { id: 'tablet', label: 'Devot for iPadOS', created: NOW, current: false },
    ],
  })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await page.evaluate(() => {
    const w = globalThis as unknown as { said: string[] }
    w.said = []
    const region = document.querySelector('p.visually-hidden[role="status"]')!
    new MutationObserver(() => w.said.push(region.textContent ?? '')).observe(region, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
  const items = panel.getByRole('list', { name: 'Devices in this vault' }).getByRole('listitem')
  for (const left of [2, 1]) {
    await items
      .nth(1)
      .getByRole('button', { name: /^Remove / })
      .click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(items).toHaveCount(left)
  }
  await expect
    .poll(async () => {
      const said = await page.evaluate(() => (globalThis as unknown as { said: string[] }).said)
      return said.filter((text) => text === 'The device was removed from sync.').length
    })
    .toBe(2)
})

test('a long device name wraps beside its Remove button', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 640 })
  const label = `Devot for iOS on a long name ${'x'.repeat(60)}`
  await fakeRust(page, {
    relayUrl: RELAY,
    enabled: true,
    enrolled: true,
    devices: [
      { id: 'mac', label: 'Devot for macOS', created: NOW - 86_400_000, current: true },
      { id: 'long', label, created: NOW, current: false },
    ],
  })
  await openSettings(page, 'Sync')
  const row = page.getByRole('tabpanel').getByRole('listitem').nth(1)
  const name = await row.getByText(label).evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getBoundingClientRect().right
  })
  const button = await row.getByRole('button').boundingBox()
  expect(name).toBeLessThanOrEqual(button!.x)
})

test.describe('the relay’s quota cap', () => {
  test.use({ timezoneId: 'Asia/Tokyo', locale: 'en-US' })
  const paused = {
    state: 'paused',
    lastSync: Date.UTC(2026, 9, 23, 19),
    code: 'E_SYNC_QUOTA',
    pausedUntil: Date.UTC(2026, 9, 24),
    upload: { sent: 20_000, total: 45_000 },
  }

  test('the main window says until when sync is paused, in local time, and the upload so far', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: paused })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'Sync paused' })
    await expect(notice).toHaveText(
      /Sync paused until 9:00\sAM: the relay has reached its quota for today, with 20,000 of 45,000 items uploaded\./,
    )
    await sendSnapshot(page, {
      relayUrl: RELAY,
      enabled: true,
      vault: true,
      enrolled: true,
      status: { state: 'idle', lastSync: Date.UTC(2026, 9, 24, 0, 1), code: null, tooLarge: 0 },
    })
    await expect(notice).toHaveCount(0)
  })

  test('a dismissed pause notice comes back with the next pause, even with the same words', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    const pausedOnly = { ...paused, upload: null }
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: pausedOnly })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'Sync paused' })
    await notice.getByRole('button', { name: 'Dismiss' }).click()
    await expect(notice).toHaveCount(0)
    const snapshot = { relayUrl: RELAY, enabled: true, vault: true, enrolled: true }
    await sendSnapshot(page, {
      ...snapshot,
      status: { state: 'idle', lastSync: Date.UTC(2026, 9, 24, 0, 1), code: null, tooLarge: 0 },
    })
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 24, 20)))
    await sendSnapshot(page, {
      ...snapshot,
      status: { ...pausedOnly, tooLarge: 0, pausedUntil: Date.UTC(2026, 9, 25) },
    })
    await expect(notice).toHaveText(/Sync paused until 9:00\sAM/)
  })

  test('a full relay is not called a daily quota, and says how to make room', async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    const full = { ...paused, code: 'E_SYNC_STORAGE_FULL', upload: null }
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: full })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'storage is full' })
    await expect(notice).toHaveText(
      /Sync paused until 9:00\sAM: the relay’s storage is full, so new and changed notes and images are not syncing\. Notes from other devices still arrive, and everything works on this device\. To sync again, remove images or notes you no longer need, or use a larger server\./,
    )
    await expect(notice).not.toContainText('quota')
    await openSettings(page, 'Sync')
    await expect(page.getByRole('tabpanel')).toContainText(
      /the relay’s storage is full, so new and changed notes and images are not syncing\. Everything still works on this device\. Remove images or notes you no longer need, or use a larger server\./,
    )
  })

  test('Settings > Sync shows the pause, the upload and a relay to update', async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    await fakeRust(page, {
      relayUrl: RELAY,
      enabled: true,
      enrolled: true,
      status: { ...paused, relayOutdated: true },
    })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText(
      /Sync paused until 9:00\sAM: the relay has reached its quota for today\. 20,000 of 45,000 items uploaded\. Code E_SYNC_QUOTA\./,
    )
    await expect(panel).toContainText('Your relay comes from an earlier release')
  })

  test('Settings > Sync says how many images are not synced, and why', async ({ page }) => {
    const idle = { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 19), code: null, tooLarge: 0 }
    await fakeRust(page, {
      relayUrl: RELAY,
      enabled: true,
      enrolled: true,
      status: { ...idle, unsyncedFiles: { count: 2, code: 'E_SYNC_ATTACHMENTS_FULL' } },
    })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText(
      '2 images are not synced: the relay has no room left for images.',
    )
    const snapshot = { relayUrl: RELAY, enabled: true, vault: true, enrolled: true }
    await sendSnapshot(page, {
      ...snapshot,
      status: { ...idle, unsyncedFiles: { count: 1, code: 'E_SYNC_ATTACHMENTS_FULL' } },
    })
    await expect(panel).toContainText('1 image is not synced: the relay has no room left')
    await sendSnapshot(page, {
      ...snapshot,
      status: { ...idle, unsyncedFiles: { count: 1, code: 'E_SYNC_RELAY_OUTDATED' } },
    })
    await expect(panel).toContainText(
      '1 image is not synced: your relay is too old to hold images. Update it',
    )
    await sendSnapshot(page, {
      ...snapshot,
      status: {
        ...idle,
        relayOutdated: true,
        unsyncedFiles: { count: 1, code: 'E_SYNC_RELAY_OUTDATED' },
      },
    })
    await expect(panel).toContainText('Your relay comes from an earlier release')
    await expect(panel).not.toContainText('image is not synced')
    await sendSnapshot(page, { ...snapshot, status: idle })
    await expect(panel).not.toContainText('not synced:')
  })

  test('Settings > Sync drops the too-large note once sync is off', async ({ page }) => {
    const snapshot = { relayUrl: RELAY, vault: true, enrolled: true }
    const status = { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 19), code: null, tooLarge: 1 }
    await fakeRust(page, { ...snapshot, enabled: true, status })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('1 note is too large for the relay')
    await sendSnapshot(page, { ...snapshot, enabled: false, status: { ...status, state: 'off' } })
    await expect(panel).toContainText('Off.')
    await expect(panel).not.toContainText('too large for the relay')
  })

  test('a long notice stays a bounded toast, clear of both window edges', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 })
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: paused })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'Sync paused' })
    await expect(notice).toBeVisible()
    const box = (await notice.boundingBox())!
    expect(box.x).toBeGreaterThan(0)
    expect(box.width).toBeLessThanOrEqual(440)
    expect(box.x + box.width).toBeLessThan(760)
    const button = (await notice.getByRole('button', { name: 'Dismiss' }).boundingBox())!
    expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width)
  })

  test('the pause notice also says how many notes are too large to sync', async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    await fakeRust(page, {
      relayUrl: RELAY,
      enabled: true,
      enrolled: true,
      status: { ...paused, upload: undefined, tooLarge: 3 },
    })
    await openApp(page)
    await expect(page.getByRole('alert').filter({ hasText: 'Sync paused' })).toHaveText(
      /Sync paused until 9:00\sAM: .* 3 notes are too large to sync and stay on this device only\./,
    )
  })

  test('once the reset has passed, the notice no longer names a time', async ({ page }) => {
    await page.clock.install({ time: new Date(Date.UTC(2026, 9, 23, 23, 50)) })
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: paused })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'Sync' })
    await expect(notice).toHaveText(/Sync paused until 9:00\sAM/)
    await page.clock.fastForward('40:00')
    await expect(notice).toHaveText(
      /The relay’s quota for today has reset; sync resumes in a moment, with 20,000 of 45,000 items uploaded so far\./,
    )
  })

  test('once the reset has passed, Settings > Sync no longer names a time', async ({ page }) => {
    await page.clock.install({ time: new Date(Date.UTC(2026, 9, 23, 23, 50)) })
    await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true, status: paused })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText(/Sync paused until 9:00\sAM/)
    await page.clock.fastForward('40:00')
    await expect(panel).toContainText(
      'The relay’s quota for today has reset; sync resumes in a moment.',
    )
    await expect(panel).not.toContainText('Sync paused until')
  })
})

const GB = 1_000_000_000
const CAPS = { rowsWritten: 80_000, requests: 80_000, storedBytes: 4 * GB, fileBytes: 3 * GB }
const ENROLLED = { relayUrl: RELAY, enabled: true, enrolled: true }
const IDLE = { state: 'idle', lastSync: Date.UTC(2026, 9, 23, 19), code: null, tooLarge: 0 }

/** What the relay answers a `usage` with, or `{ error }` for a failure; changed later with `setUsage`. */
async function fakeUsage(page: Page, usage: unknown) {
  await page.addInitScript((answer) => {
    const w = globalThis as unknown as TestWindow
    w.devotUsage = answer
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      sync_usage: () => {
        const now = w.devotUsage as { error?: string }
        if (now.error) throw now.error
        return now
      },
    }
  }, usage)
}

const setUsage = (page: Page, usage: unknown) =>
  page.evaluate((answer) => {
    ;(globalThis as unknown as TestWindow).devotUsage = answer
  }, usage)

/** A new sync state, so the main window reads the relay's storage again. */
const settle = (page: Page, code: string) =>
  sendSnapshot(page, {
    relayUrl: RELAY,
    enabled: true,
    vault: true,
    enrolled: true,
    status: { ...IDLE, code },
  })

test.describe('storage', () => {
  test('Settings > Sync shows notes, images, the total and the room left', async ({ page }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 1.5 * GB, fileBytes: 1 * GB, caps: CAPS })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('Notes and Other Records')
    await expect(panel).toContainText('500 MB')
    await expect(panel).toContainText('1 GB of 3 GB')
    await expect(panel).toContainText('1.5 GB of 4 GB')
    await expect(panel).toContainText('2.5 GB. Images can use 2 GB of that.')
    await expect(panel).toContainText('up to 4 GB in all, and up to 3 GB of that for images')
    await expect(panel).not.toContainText('% full')
  })

  test('Settings > Sync warns near a cap and says what to do at it', async ({ page }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 3.3 * GB, fileBytes: 1 * GB, caps: CAPS })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('The relay’s storage is more than 80% full.')
    await expect(panel).toContainText('700 MB. Images can use 700 MB of that.')
    await setUsage(page, { storedBytes: 4 * GB, fileBytes: 1 * GB, caps: CAPS })
    await settle(page, 'E_SYNC_OFFLINE')
    await expect(panel).toContainText(
      'The relay’s storage is full, so new and changed notes and images are not syncing.',
    )
    await expect(panel).toContainText('None left.')
    await setUsage(page, { storedBytes: 3 * GB + 1e6, fileBytes: 3 * GB, caps: CAPS })
    await settle(page, 'E_SYNC_PROTOCOL')
    await expect(panel).toContainText('The relay has no room left for images')
    await expect(panel).toContainText('Images have used their share, so only notes can use it.')
  })

  test('Settings > Sync says so when the relay has no cap, or does not say', async ({ page }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 9 * GB, fileBytes: 2 * GB, caps: null })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('No limit. This relay runs without a storage cap')
    await expect(panel).toContainText('9 GB')
    await expect(panel).not.toContainText('% full')
    await setUsage(page, { storedBytes: 9 * GB, fileBytes: 2 * GB })
    await settle(page, 'E_SYNC_OFFLINE')
    await expect(panel).toContainText('Not known. This relay does not say what it may hold.')
    await expect(panel).not.toContainText('% full')
  })

  test('Settings > Sync says when storage cannot be read, and tries again on request', async ({
    page,
  }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { error: 'E_SYNC_OFFLINE' })
    await openSettings(page, 'Sync')
    const panel = page.getByRole('tabpanel')
    await expect(panel).toContainText('The relay cannot be reached, so its storage is not shown.')
    await setUsage(page, { storedBytes: 1 * GB, fileBytes: 0, caps: CAPS })
    await panel.getByRole('button', { name: 'Check Again' }).click()
    await expect(panel).toContainText('1 GB of 4 GB')
    await setUsage(page, { error: 'E_SYNC_BAD_MESSAGE' })
    await settle(page, 'E_SYNC_OFFLINE')
    await expect(panel).toContainText('Your relay is from an earlier release and cannot report')
    await expect(panel.getByRole('button', { name: 'Check Again' })).toHaveCount(0)
  })

  test('there is no storage until the device is in a vault', async ({ page }) => {
    await fakeRust(page)
    await fakeUsage(page, { storedBytes: 1, fileBytes: 0, caps: CAPS })
    await openSettings(page, 'Sync')
    await expect(page.getByRole('tabpanel')).not.toContainText('Room Left')
    expect(await calls(page, 'sync_usage')).toEqual([])
  })

  test('the main window warns once at 80%, stays quiet on the next launch, and tells the next band', async ({
    page,
  }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 3.3 * GB, fileBytes: 0, caps: CAPS })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'more than 80% full' })
    await expect(notice).toHaveText(
      /The relay’s storage is more than 80% full\. Sync keeps working/,
    )
    await notice.getByRole('button', { name: 'Dismiss' }).click()

    await page.reload()
    await openApp(page)
    await expect(page.getByRole('alert').filter({ hasText: 'Sync' })).toHaveCount(0)
    await expect.poll(async () => (await calls(page, 'sync_usage')).length).toBeGreaterThan(0)

    await setUsage(page, { storedBytes: 4 * GB, fileBytes: 0, caps: CAPS })
    await settle(page, 'E_SYNC_OFFLINE')
    const full = page.getByRole('alert').filter({ hasText: 'storage is full' })
    await expect(full).toContainText('not syncing')
    await expect(full).toContainText(
      'remove images or notes you no longer need, or use a larger server',
    )
  })

  test('the main window names images when only their share is used up', async ({ page }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 3.1 * GB, fileBytes: 3 * GB, caps: CAPS })
    await openApp(page)
    await expect(
      page.getByRole('alert').filter({ hasText: 'no room left for images' }),
    ).toContainText('Notes keep syncing')
  })

  test('the main window says nothing for a relay with no cap, one that does not say, or no answer', async ({
    page,
  }) => {
    await fakeRust(page, { ...ENROLLED, status: IDLE })
    await fakeUsage(page, { storedBytes: 9 * GB, fileBytes: 0, caps: null })
    await openApp(page)
    await expect.poll(async () => (await calls(page, 'sync_usage')).length).toBeGreaterThan(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await setUsage(page, { storedBytes: 9 * GB, fileBytes: 0 })
    await settle(page, 'E_SYNC_OFFLINE')
    await setUsage(page, { error: 'E_SYNC_OFFLINE' })
    await settle(page, 'E_SYNC_PROTOCOL')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('a full storage pause is told once, not twice', async ({ page }) => {
    await page.clock.setFixedTime(new Date(Date.UTC(2026, 9, 23, 20)))
    const full = {
      state: 'paused',
      lastSync: Date.UTC(2026, 9, 23, 19),
      code: 'E_SYNC_STORAGE_FULL',
      tooLarge: 0,
      pausedUntil: Date.UTC(2026, 9, 24),
    }
    await fakeRust(page, { ...ENROLLED, status: full })
    await fakeUsage(page, { storedBytes: 4 * GB, fileBytes: 0, caps: CAPS })
    await openApp(page)
    const notice = page.getByRole('alert').filter({ hasText: 'storage is full' })
    await expect(notice).toHaveCount(1)
    await expect(notice).toContainText('Sync paused until')
    await expect.poll(async () => (await calls(page, 'sync_usage')).length).toBeGreaterThan(0)
    await expect(notice).toHaveCount(1)
  })
})

test('copies the pairing link, which names the relay, as a secret', async ({ page }) => {
  await fakeRust(page, { relayUrl: RELAY, enabled: true, enrolled: true })
  await openSettings(page, 'Sync')
  const panel = page.getByRole('tabpanel')
  await panel.getByRole('button', { name: 'Show Pairing Code' }).click()
  await panel.getByRole('button', { name: 'Copy Link' }).click()
  await expect(panel.getByRole('status').first()).toContainText('The pairing link was copied.')
  expect(await calls(page, 'clipboard_write_secret')).toEqual([
    {
      text: `devot://pair?relay=${encodeURIComponent(RELAY)}&code=${CODE.replace(/-/g, '')}`,
    },
  ])
  expect(await clipboardWrites(page)).toEqual([])
})
