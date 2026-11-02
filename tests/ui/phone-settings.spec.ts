import type { Locator, Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })
const root = (page: Page) => page.getByRole('region', { name: 'Settings' })

async function openSettings(page: Page): Promise<void> {
  await page.goto('/')
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
}

async function openPane(page: Page, name: string): Promise<Locator> {
  await openSettings(page)
  await root(page)
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  const pane = page.locator(`section.phone-screen[aria-label="${name}"]`)
  await expect(pane.locator('.settings-section')).toBeAttached()
  return pane
}

const glassOpaque = (page: Page) =>
  tabs(page).evaluate((bar) => getComputedStyle(bar).backdropFilter === 'none')

test('Settings has its groups, and what lives on the Mac says so and does not open', async ({
  page,
}) => {
  await openSettings(page)
  for (const title of ['General', 'Sync & storage', 'AI & integrations']) {
    await expect(root(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  for (const name of ['Keyboard', 'Mirror', 'Integrations', 'Local HTTP API', 'Plugins']) {
    const row = root(page).getByRole('button', { name: new RegExp(`^${name}`) })
    await expect(row).toBeDisabled()
    await expect(row).toContainText('On the Mac')
  }
})

test('the search button finds a pane by name and opens it', async ({ page }) => {
  await openSettings(page)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  const field = root(page).getByRole('searchbox')
  await field.fill('appear')
  await root(page)
    .locator('.phone-settings-search')
    .getByRole('button', { name: /^Appearance/ })
    .click()
  await expect(page.locator('section.phone-screen[aria-label="Appearance"]')).toBeVisible()
})

test('a search with no match says so, and a Mac-only pane is not found', async ({ page }) => {
  await openSettings(page)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  await root(page).getByRole('searchbox').fill('plugins')
  await expect(root(page).getByText('No matching settings')).toBeVisible()
  await root(page).getByRole('button', { name: 'Close search' }).click()
  await expect(root(page).getByRole('searchbox')).toHaveCount(0)
})

test('Classic makes the glass opaque, hides the slider and leaves the Mac keys alone', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  const slider = pane.getByRole('slider', { name: 'Glass Transparency' })
  await expect(slider).toBeVisible()
  await pane.getByRole('radio', { name: 'Classic' }).click()
  await expect(slider).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-phone-glass', 'classic')
  expect(await glassOpaque(page)).toBe(true)
  const stored = await page.evaluate(() => ({
    style: localStorage.getItem('devot.phone.interfaceStyle'),
    keys: Object.keys(localStorage).filter((k) => /interfaceStyle|windowTransparency/.test(k)),
  }))
  expect(stored.style).toBe('classic')
  expect(stored.keys).toEqual(['devot.phone.interfaceStyle'])
  await pane.getByRole('radio', { name: 'Glass', exact: true }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-phone-glass', 'classic')
  expect(await glassOpaque(page)).toBe(false)
})

test('the transparency slider scales the glass tint and survives a reload', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  const slider = pane.getByRole('slider', { name: 'Glass Transparency' })
  const alpha = () =>
    tabs(page).evaluate((bar) => {
      const parts = getComputedStyle(bar).backgroundColor.match(/[\d.]+/g)!
      return parts.length > 4 || parts.length === 4 ? Number(parts.at(-1)) : 1
    })
  const start = await alpha()
  await slider.fill('100')
  await expect.poll(alpha).toBeCloseTo(start / 2, 1)
  await slider.fill('-100')
  await expect.poll(alpha).toBe(1)
  await page.reload()
  const stored = await page.evaluate(() => localStorage.getItem('devot.phone.glassTransparency'))
  expect(stored).toBe('-100')
  await expect.poll(alpha).toBe(1)
})

test('controls have the design sizes and reach their targets', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  const segmented = (await pane.locator('.phone-segmented').first().boundingBox())!
  expect(segmented.height).toBe(36)
  const hit = await pane
    .locator('.phone-segment')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el, '::after').height))
  expect(hit).toBeGreaterThanOrEqual(44)
  const slider = (await pane.locator('.phone-slider').first().boundingBox())!
  expect(slider.height).toBeGreaterThanOrEqual(44)
  await pane.getByRole('radio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
})

test('a long explanation opens in a sheet, and Done closes it', async ({ page }) => {
  const pane = await openPane(page, 'Appearance')
  await expect(pane.getByText('Glass lets the background show through')).toHaveCount(0)
  const button = pane.getByRole('button', { name: 'About Interface' })
  const box = (await button.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await button.click()
  const sheet = page.getByRole('dialog', { name: 'Interface' })
  await expect(sheet.getByText('Glass lets the background show through')).toBeVisible()
  const done = (await sheet.getByRole('button', { name: 'Done' }).boundingBox())!
  expect(done.height).toBeCloseTo(50, 1)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
})

test('shared rows show their explanation behind an info button on a phone', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  await expect(pane.locator('.setting-description')).toHaveCount(0)
  await pane.getByRole('button', { name: 'About Unordered List Bullet' }).click()
  await expect(page.getByRole('dialog', { name: 'Unordered List Bullet' })).toBeVisible()
})

test('a pane switch is 51 by 31', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  const box = (await pane.getByRole('switch').first().boundingBox())!
  expect(box.width).toBe(51)
  expect(box.height).toBe(31)
})

test('the AI pane picks a provider with a segmented control and shows only its fields', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const provider = (endpoint: string) => ({
      endpoint,
      model: '',
      defaultEndpoint: endpoint,
      defaultModel: 'm',
      key: 'unset',
    })
    const state: Record<string, unknown> = {
      active: 'anthropic',
      suggestOnIdle: false,
      anthropic: provider('https://a.example'),
      openai: provider('https://o.example'),
    }
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      ai_settings_get: () => state,
      ai_settings_set: (args: { settings: Record<string, unknown> }) => {
        for (const id of ['anthropic', 'openai'] as const) {
          Object.assign(state[id] as object, args.settings[id])
        }
        state['active'] = args.settings['active']
        state['suggestOnIdle'] = args.settings['suggestOnIdle']
        return JSON.parse(JSON.stringify(state))
      },
    }
  })
  const pane = await openPane(page, 'AI')
  await expect(pane.getByRole('radio', { name: 'Anthropic' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(pane.getByRole('textbox', { name: 'Endpoint' })).toHaveCount(1)
  await pane.getByRole('radio', { name: /^OpenAI/ }).click()
  await expect(pane.getByRole('radio', { name: /^OpenAI/ })).toHaveAttribute('aria-checked', 'true')
  await expect(pane.getByRole('textbox', { name: 'Endpoint' })).toHaveValue('https://o.example')
  await pane.getByRole('switch').click()
  await expect(pane.getByRole('switch')).toBeChecked()
})

test('the Sync pane lists devices, marks this one and offers pairing', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      sync_get: () => ({
        relayUrl: 'https://relay.example',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'idle', lastSync: 1_700_000_000_000, code: null, pausedUntil: null },
      }),
      sync_devices: () => [
        { id: 'd1', label: 'This phone', created: 1_700_000_000_000, current: true },
        { id: 'd2', label: 'Desk', created: 1_690_000_000_000, current: false },
      ],
      sync_recovery_key: () => null,
    }
  })
  const pane = await openPane(page, 'Sync')
  await expect(pane.getByText(/^Last synced/)).toBeVisible()
  await expect(pane.getByRole('listitem').filter({ hasText: 'This phone' })).toContainText('You')
  await expect(pane.getByRole('button', { name: 'Remove' }).first()).toBeVisible()
  await expect(pane.locator('.phone-accent-button')).toBeVisible()
  await pane.getByRole('button', { name: 'About Recovery Key' }).click()
  await expect(page.getByRole('dialog', { name: 'Recovery Key' })).toBeVisible()
})
