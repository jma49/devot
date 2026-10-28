import type { Page } from '@playwright/test'
import { expect, openSettings, test, type TestWindow } from './fixtures'

// Settings > Integrations > Local HTTP API. Rust is faked in the page: it keeps
// the settings, says only whether a token is stored, and gives the token only
// when Settings asks to show it, as the real commands do.

const FIRST = 'dvt_first0000000000000000000000000000000000000'
const SECOND = 'dvt_second000000000000000000000000000000000000'

async function fakeRust(
  page: Page,
  options: { problem?: string; token?: string; holdFirstSet?: boolean } = {},
) {
  await page.addInitScript(
    ([first, second, problem, initialToken, holdFirstSet]) => {
      const w = globalThis as unknown as TestWindow
      const state: Record<string, any> = {
        enabled: false,
        port: 27484,
        scope: 'read',
        listening: null,
        problem: null,
        token: initialToken ?? 'unset',
      }
      let secret: string | null = null
      const tokens = [first, second]
      const view = () => ({ ...state })
      // A held answer, so a test can change both controls before the first save comes back.
      let release: (() => void) | undefined
      const held = holdFirstSet ? new Promise<void>((resolve) => (release = resolve)) : null
      let firstSet = true
      ;(w as unknown as { devotReleaseHttpApi: () => void }).devotReleaseHttpApi = () => release?.()
      w.devotIpcMocks = {
        http_api_get: () => view(),
        http_api_set: async (args: { enabled: boolean; port: number }) => {
          if (held && firstSet) {
            firstSet = false
            await held
          }
          state['enabled'] = args.enabled
          state['port'] = args.port
          if (args.enabled && secret === null) {
            secret = tokens.shift() ?? null
            state['token'] = 'set'
          }
          state['listening'] = args.enabled && !problem ? args.port : null
          state['problem'] = args.enabled && problem ? problem : null
          return view()
        },
        http_api_token_rotate: (args: { scope: string }) => {
          secret = tokens.shift() ?? null
          state['scope'] = args.scope
          state['token'] = 'set'
          return view()
        },
        http_api_token_reveal: () => {
          if (secret === null) throw 'E_HTTP_API_TOKEN_MISSING'
          return secret
        },
      }
    },
    [
      FIRST,
      SECOND,
      options.problem ?? null,
      options.token ?? null,
      options.holdFirstSet ?? false,
    ] as const,
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

const section = (page: Page) => page.getByRole('region', { name: 'Local HTTP API' })

test('is off by default and turns on at the port shown, making a token', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Integrations')
  const api = section(page)
  const toggle = api.getByRole('switch', { name: 'Allow Local HTTP API' })
  await expect(toggle).not.toBeChecked()
  await expect(api.getByRole('button', { name: 'Show' })).toBeDisabled()
  await expect(api.getByRole('spinbutton', { name: 'Port' })).toHaveValue('27484')
  await expect(api.locator('code').last()).toHaveText(
    'curl -H "Authorization: Bearer $DEVOT_TOKEN" http://127.0.0.1:27484/v1/notebooks',
  )
  await toggle.check()
  await expect(api).toContainText('Listening on 127.0.0.1:27484.')
  expect(await calls(page, 'http_api_set')).toEqual([{ enabled: true, port: 27484 }])
  // The token is not read until it is asked for.
  expect(await calls(page, 'http_api_token_reveal')).toEqual([])
  await api.getByRole('button', { name: 'Show' }).click()
  await expect(api.getByLabel('Token', { exact: true })).toHaveText(FIRST)
  await api.getByRole('button', { name: 'Hide' }).click()
  await expect(api.getByText(FIRST)).toHaveCount(0)
})

test('changes the port once typing pauses', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Integrations')
  const api = section(page)
  await api.getByRole('switch', { name: 'Allow Local HTTP API' }).check()
  const port = api.getByRole('spinbutton', { name: 'Port' })
  await port.fill('40123')
  await expect(api).toContainText('Listening on 127.0.0.1:40123.')
  // Below 1024 is never sent.
  await port.fill('80')
  await port.blur()
  await expect(port).toHaveValue('40123')
  expect(await calls(page, 'http_api_set')).toEqual([
    { enabled: true, port: 27484 },
    { enabled: true, port: 40123 },
  ])
})

test('the port field is wide enough for five digits', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Integrations')
  const port = section(page).getByRole('spinbutton', { name: 'Port' })
  await expect(port).toHaveValue('27484')
  // 65535 is the widest port, with the spinner beside it (A157).
  const width = await port.evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThanOrEqual(80)
  expect(await port.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
})

test('the switch and the port are saved in turn, each with the other’s change', async ({
  page,
}) => {
  // The first save waits for the test, so the port is changed before it comes back (A184).
  await fakeRust(page, { holdFirstSet: true })
  await openSettings(page, 'Integrations')
  const api = section(page)
  const port = api.getByRole('spinbutton', { name: 'Port' })
  await api.getByRole('switch', { name: 'Allow Local HTTP API' }).click()
  await expect.poll(async () => (await calls(page, 'http_api_set')).length).toBe(1)
  await port.fill('40123')
  // Its typing pause passes while the first save is still out.
  await page.waitForTimeout(600)
  expect(await calls(page, 'http_api_set')).toEqual([{ enabled: true, port: 27484 }])

  await page.evaluate(() =>
    (globalThis as unknown as { devotReleaseHttpApi(): void }).devotReleaseHttpApi(),
  )
  await expect(api).toContainText('Listening on 127.0.0.1:40123.')
  // The second save carries the port and the switch that was turned on, not a stale `enabled`.
  expect(await calls(page, 'http_api_set')).toEqual([
    { enabled: true, port: 27484 },
    { enabled: true, port: 40123 },
  ])
})

test('says why it is not listening', async ({ page }) => {
  await fakeRust(page, { problem: 'E_HTTP_API_PORT_IN_USE' })
  await openSettings(page, 'Integrations')
  const api = section(page)
  await api.getByRole('switch', { name: 'Allow Local HTTP API' }).check()
  await expect(api).toContainText('Not listening (E_HTTP_API_PORT_IN_USE).')
})

test('a new token or another access replaces the token', async ({ page }) => {
  await fakeRust(page)
  await openSettings(page, 'Integrations')
  const api = section(page)
  await api.getByRole('switch', { name: 'Allow Local HTTP API' }).check()
  await api.getByRole('button', { name: 'Show' }).click()
  await expect(api.getByLabel('Token', { exact: true })).toHaveText(FIRST)
  await api.getByRole('combobox', { name: 'Token Access' }).selectOption('readWrite')
  await expect(api.getByRole('status')).toHaveText('A new token was made.')
  // The old token is not left on screen.
  await expect(api.getByText(FIRST)).toHaveCount(0)
  expect(await calls(page, 'http_api_token_rotate')).toEqual([{ scope: 'readWrite' }])
  await api.getByRole('button', { name: 'Copy' }).click()
  await expect(api.getByRole('status')).toHaveText('The token was copied.')
  expect(await calls(page, 'clipboard_write_text')).toEqual([{ text: SECOND }])
})

test('shows a failure by its code', async ({ page }) => {
  await fakeRust(page, { token: 'unknown' })
  await openSettings(page, 'Integrations')
  const api = section(page)
  await api.getByRole('button', { name: 'Show' }).click()
  await expect(api.getByRole('alert')).toContainText('E_HTTP_API_TOKEN_MISSING')
})
