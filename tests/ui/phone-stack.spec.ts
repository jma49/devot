import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { openPhoneNote } from './phone'

// The page's own stack, which the kill switch's fallback still pushes its note and Settings panes on.

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
  reducedMotion: 'no-preference',
})

const zone = (page: Page) => page.getByTestId('phone-back-zone')
const note = (page: Page) => page.locator('section.phone-screen:has(.phone-note-scroll)')
const back = (page: Page) => note(page).getByRole('button', { name: 'Back', exact: true })
const topLayer = (page: Page) =>
  page.locator('.phone-stack:not([hidden]) > .phone-layer:not([data-away])').last()

async function dragEdge(page: Page, to: number, restMs = 0): Promise<void> {
  const box = await zone(page).boundingBox()
  if (!box) throw new Error('no back zone')
  const y = box.y + box.height / 2
  await page.mouse.move(4, y)
  await page.mouse.down()
  await page.mouse.move(to, y, { steps: 12 })
  if (restMs > 0) await page.waitForTimeout(restMs)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await openPhoneNote(page)
  await expect(note(page).locator('.cm-content')).toBeAttached()
  await expect(zone(page)).toHaveCount(1)
  await page.waitForTimeout(600)
})

test('the back button is at least 44 points, labelled, and pops', async ({ page }) => {
  const box = await back(page).boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
  await back(page).click()
  await expect(zone(page)).toHaveCount(0)
  await expect(note(page)).toHaveCount(0)
})

test('a back swipe under the threshold springs back', async ({ page }) => {
  await dragEdge(page, 80, 200)
  await expect(zone(page)).toHaveCount(1)
  await expect.poll(async () => (await topLayer(page).boundingBox())?.x).toBe(0)
})

test('a back swipe past the threshold pops', async ({ page }) => {
  await dragEdge(page, 200)
  await expect(zone(page)).toHaveCount(0)
})

test('a back swipe the system takes springs back and leaves the screen usable', async ({
  page,
}) => {
  const box = (await zone(page).boundingBox())!
  await page.mouse.move(4, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(92, box.y + 100, { steps: 8 })
  await expect(topLayer(page)).toHaveAttribute('data-dragging', 'true')
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('blur', { pointerId: 1 })))
  await expect(topLayer(page)).not.toHaveAttribute('data-dragging')
  await expect.poll(async () => (await topLayer(page).boundingBox())?.x).toBe(0)
  await page.mouse.up()
  await back(page).click()
  await expect(zone(page)).toHaveCount(0)
})

test('Back pressed mid-swipe leaves the screen below where it belongs', async ({ page }) => {
  const box = (await zone(page).boundingBox())!
  await page.mouse.move(4, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(92, box.y + 100, { steps: 8 })
  await back(page).evaluate((el) => (el as HTMLElement).click())
  await expect(zone(page)).toHaveCount(0)
  await expect.poll(async () => (await topLayer(page).boundingBox())?.x).toBe(0)
  await expect(topLayer(page)).not.toHaveAttribute('data-dragging')
})

test('Back slides the popped screen out, keeping its own screen', async ({ page }) => {
  // Slowed five times (the UI tests' build reads it on each motion), so a busy frame cannot skip the slide.
  await page.evaluate(() => {
    localStorage.setItem('devot.motionScale', '5')
    document.documentElement.style.setProperty('--motion-duration-phone-push', '2500ms')
  })
  const pop = await back(page).evaluate(async (button) => {
    const layer = button.closest('.phone-layer') as HTMLElement
    const screen = layer.querySelector('section.phone-screen')!
    const xs: number[] = []
    const screens = new Set<Element>([screen])
    let kept = true
    ;(button as HTMLElement).click()
    const until = performance.now() + 4000
    while (performance.now() < until) {
      await new Promise(requestAnimationFrame)
      for (const each of document.querySelectorAll('section.phone-screen:has(.phone-note-scroll)'))
        screens.add(each)
      if (!layer.isConnected) continue
      kept &&= screen.isConnected
      xs.push(new DOMMatrix(getComputedStyle(layer).transform).m41)
    }
    return { xs, screens: screens.size, kept, width: window.innerWidth }
  })
  expect(pop.xs.some((x) => x > 0 && x < pop.width)).toBe(true)
  expect(pop.screens).toBe(1)
  expect(pop.kept).toBe(true)
  await expect(note(page)).toHaveCount(0)
})
