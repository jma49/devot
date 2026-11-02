import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })
const tab = (page: Page, name: string) => tabs(page).getByRole('button', { name })

async function dragEdge(page: Page, to: number, restMs = 0): Promise<void> {
  const box = await page.getByTestId('phone-back-zone').boundingBox()
  if (!box) throw new Error('no back zone')
  const y = box.y + box.height / 2
  await page.mouse.move(4, y)
  await page.mouse.down()
  await page.mouse.move(to, y, { steps: 12 })
  if (restMs > 0) await page.waitForTimeout(restMs)
  await page.mouse.up()
}

const openTemplates = (page: Page) => page.getByRole('button', { name: 'Templates' }).click()

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(tabs(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`shows three tabs with Library selected, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await expect(tabs(page).getByRole('button')).toHaveCount(3)
    await expect(tab(page, 'Library')).toHaveAttribute('aria-current', 'page')
    const box = await tabs(page).boundingBox()
    expect(box).toMatchObject({ x: 20, width: 350, height: 64 })
    expect(box!.y + box!.height).toBe(844 - 24)
  })
}

test('keeps a stack per tab, and tapping the current tab pops to its root', async ({ page }) => {
  await openTemplates(page)
  await expect(page.getByRole('region', { name: 'Templates' })).toBeVisible()
  await tab(page, 'Settings').evaluate((el) => (el as HTMLElement).click())
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible()
  await tab(page, 'Library').click()
  await expect(page.getByRole('region', { name: 'Templates' })).toBeVisible()
  await tab(page, 'Library').evaluate((el) => (el as HTMLElement).click())
  await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0)
})

test('the back button pops', async ({ page }) => {
  await openTemplates(page)
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByTestId('phone-back-zone')).toHaveCount(0)
})

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('a push slides in and moves the screen below 30%', async ({ page }) => {
    await openTemplates(page)
    const below = page.locator('.phone-stack:not([hidden]) > .phone-layer').first()
    await expect.poll(async () => (await below.boundingBox())?.x).toBeCloseTo(-117, 0)
  })

  test('a back swipe under the threshold springs back', async ({ page }) => {
    await openTemplates(page)
    await page.waitForTimeout(600)
    await dragEdge(page, 80, 200)
    await expect(page.getByTestId('phone-back-zone')).toHaveCount(1)
  })

  test('a back swipe past the threshold pops', async ({ page }) => {
    await openTemplates(page)
    await page.waitForTimeout(600)
    await dragEdge(page, 200)
    await expect(page.getByTestId('phone-back-zone')).toHaveCount(0)
  })
})

test('every tab and back button is at least 44 points and labelled', async ({ page }) => {
  await openTemplates(page)
  const back = await page.getByRole('button', { name: 'Back' }).boundingBox()
  expect(back!.width).toBeGreaterThanOrEqual(44)
  expect(back!.height).toBeGreaterThanOrEqual(44)
  await page.getByRole('button', { name: 'Back' }).click()
  for (const button of await tabs(page).getByRole('button').all()) {
    const box = await button.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(box!.width).toBeGreaterThanOrEqual(44)
  }
})
