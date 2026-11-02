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

test.describe('the top bar', () => {
  const screens = [
    ['Library', 'New Notebook', 'Search'],
    ['Notes', 'Status filter', 'Search'],
    ['Settings', 'Pair a device', 'Search Settings'],
  ] as const

  for (const [tabName, first, second] of screens) {
    test(`${tabName} has a left title and one capsule of two buttons`, async ({ page }) => {
      await tab(page, tabName).evaluate((el) => (el as HTMLElement).click())
      const screen = page.locator('.phone-stack:not([hidden]) section.phone-screen').last()
      const title = screen.getByRole('heading', { level: 1 })
      const box = (await title.boundingBox())!
      expect(box.x).toBe(20)
      await expect(title).toHaveCSS('font-size', '22px')
      await expect(title).toHaveCSS('font-weight', '700')
      await expect(title).toHaveCSS('text-align', /start|left/)
      await expect(title.locator('*')).toHaveCount(0)

      const capsule = screen.locator('.phone-topbar .phone-capsule')
      await expect(capsule).toHaveCount(1)
      const capsuleBox = (await capsule.boundingBox())!
      expect(capsuleBox).toMatchObject({ y: 12, height: 44, width: 96 })
      expect(capsuleBox.x + capsuleBox.width).toBe(374)
      for (const name of [first, second]) {
        const button = (await capsule.getByRole('button', { name, exact: true }).boundingBox())!
        expect(button).toMatchObject({ width: 48, height: 44 })
      }
    })
  }

  test('a pushed screen puts its title after a 44 back circle', async ({ page }) => {
    await openTemplates(page)
    const screen = page.getByRole('region', { name: 'Templates' })
    expect(await screen.getByRole('button', { name: 'Back' }).boundingBox()).toMatchObject({
      x: 16,
      width: 44,
      height: 44,
    })
    expect((await screen.getByRole('heading', { level: 1 }).boundingBox())!.x).toBe(74)
  })

  test('a frosted band sits behind the bar and content starts below it', async ({ page }) => {
    const screen = page.getByRole('region', { name: 'Library' })
    const band = screen.locator('.phone-topbar-band')
    expect(await band.boundingBox()).toMatchObject({ y: 0, height: 68, width: 390 })
    const filter = await band.evaluate((el) => getComputedStyle(el).backdropFilter)
    expect(filter).toBe('blur(20px) saturate(1.8)')
    const scroll = screen.locator('.phone-scroll')
    await expect(scroll).toHaveCSS('padding-top', '80px')
  })
})

test('a grouped page uses the grid: card 16, row 32, group title 26, 44 rows', async ({ page }) => {
  const screen = page.getByRole('region', { name: 'Library' })
  const card = screen.locator('.phone-card').first()
  await expect(card).toHaveCSS('border-radius', '22px')
  expect((await card.boundingBox())!.x).toBe(16)
  const row = card.locator('.phone-grouped-open').first()
  const box = (await row.boundingBox())!
  expect(box.x).toBe(20)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await expect(row).toHaveCSS('padding-left', '12px')
  const head = screen.locator('.phone-section-head').first()
  expect((await head.boundingBox())!.x).toBe(26)
  await expect(head).toHaveCSS('font-size', '14px')
  await expect(head).toHaveCSS('font-weight', '500')
  await expect(head).toHaveCSS('text-transform', 'none')
})

test('counts use the shared mono figures', async ({ page }) => {
  const count = page.getByRole('region', { name: 'Library' }).locator('.phone-figures').first()
  await expect(count).toHaveCSS('font-variant-numeric', 'tabular-nums')
  await expect(count).toHaveCSS('font-family', /monospace/)
})

test('one background behind every page', async ({ page }) => {
  const color = (name: string) =>
    page
      .locator(`section.phone-screen[aria-label="${name}"]`)
      .evaluate((el) => getComputedStyle(el).backgroundColor)
  const library = await color('Library')
  await tab(page, 'Notes').evaluate((el) => (el as HTMLElement).click())
  expect(await color('All Notes')).toBe(library)
})
