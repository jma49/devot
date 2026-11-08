// iPhone Settings rows either change what the phone shows or are left out of it.
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { showPhoneTab } from './phone'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const root = (page: Page) => page.getByRole('region', { name: 'Settings' })

function crashReports(page: Page, available: boolean) {
  return page.addInitScript((shown) => {
    window.devotIpcMocks = {
      ...window.devotIpcMocks,
      crash_reports_get: { available: shown, on: false },
    }
  }, available)
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/')
  await showPhoneTab(page, 'settings')
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

const screenImage = (page: Page) =>
  page
    .locator('section.phone-screen')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundImage)

test('a gradient theme shows behind the phone screens, and Default shows none', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  expect(await screenImage(page)).toMatch(/, none$/)
  await pane
    .getByRole('radiogroup', { name: 'Light Mode Theme' })
    .getByRole('radio', { name: 'Dawn' })
    .check({ force: true })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dawn')
  await expect.poll(() => screenImage(page)).toMatch(/linear-gradient\(160deg/)
  const faint = await page
    .locator('.phone-app')
    .evaluate((el) => [
      getComputedStyle(el).getPropertyValue('--color-phone-text-faint'),
      getComputedStyle(el).getPropertyValue('--color-phone-text-secondary'),
    ])
  expect(faint[0]).toBe(faint[1])
})

test('App Font sets the font of the phone chrome, and Default is the system font', async ({
  page,
}) => {
  const pane = await openPane(page, 'Editing')
  const chrome = () => page.locator('.phone-app').evaluate((el) => getComputedStyle(el).fontFamily)
  expect(await chrome()).toMatch(/^-apple-system/)
  await pane.locator('select[id$="-app-font"]').selectOption('menlo')
  await expect.poll(chrome).toMatch(/^Menlo/)
})

test('Font Family offers no Installed Font on the phone', async ({ page }) => {
  const pane = await openPane(page, 'Editing')
  for (const select of await pane.locator('select[id$="-font"]').all()) {
    await expect(select.locator('option[value="installed"]')).toHaveCount(0)
    await expect(select.locator('option[value="imported"]')).toHaveCount(1)
  }
})

test('Preview leaves out Synced Scrolling', async ({ page }) => {
  const pane = await openPane(page, 'Preview')
  await expect(pane.getByRole('switch', { name: 'Load Images from the Web' })).toBeAttached()
  await expect(pane.getByText('Synced Scrolling')).toHaveCount(0)
})

test('Settings lists no Usage, which the phone does not record, in its rows or its search', async ({
  page,
}) => {
  await openSettings(page)
  await expect(root(page).getByRole('button', { name: /^License/ })).toBeVisible()
  await expect(root(page).getByRole('button', { name: /^Usage/ })).toHaveCount(0)
  await root(page).getByRole('button', { name: 'Search Settings' }).click()
  await root(page).getByRole('searchbox').fill('usage')
  await expect(root(page).getByText('No matching settings')).toBeVisible()
})

test('General is always listed and opens on Default Notebook', async ({ page }) => {
  const pane = await openPane(page, 'General')
  await expect(pane.getByRole('combobox', { name: 'Default Notebook' })).toBeAttached()
  await expect(pane.getByRole('switch', { name: 'Send Crash Reports' })).toHaveCount(0)
})

test('General offers crash reports where this build can send them', async ({ page }) => {
  await crashReports(page, true)
  const pane = await openPane(page, 'General')
  await expect(pane.getByRole('switch', { name: 'Send Crash Reports' })).toBeAttached()
})
