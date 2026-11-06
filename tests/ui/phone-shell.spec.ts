import type { Locator, Page } from '@playwright/test'
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

const rootScale = (page: Page, name: string) =>
  page
    .locator('.phone-app')
    .evaluate((el, prop) => Number(getComputedStyle(el).getPropertyValue(prop) || 1), name)
const textScale = (page: Page) => rootScale(page, '--phone-text-scale')
const barScale = (page: Page) => rootScale(page, '--phone-bar-text-scale')
const cssPx = (locator: Locator, prop: 'fontSize') =>
  locator.evaluate((el, name) => Number.parseFloat(getComputedStyle(el)[name]), prop)

const topLayer = (page: Page) =>
  page.locator('.phone-stack:not([hidden]) > .phone-layer:not([data-away])').last()

const openTemplates = (page: Page) => page.getByRole('button', { name: 'Templates' }).click()

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(tabs(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`shows four icon-only tabs with Library selected, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await expect(tabs(page).getByRole('button')).toHaveCount(4)
    await expect(tab(page, 'Library')).toHaveAttribute('aria-current', 'page')
    for (const name of ['Notes', 'Library', 'Activity', 'Settings']) {
      await expect(tab(page, name)).toHaveText('')
    }
    const box = await tabs(page).boundingBox()
    expect(box).toMatchObject({ x: 16, width: 286, height: 62 })
    expect(box!.y + box!.height).toBe(844 - 24)
    const lens = tabs(page).locator('.phone-tabbar-lens')
    await expect(lens).toHaveCSS('border-radius', '27px')
    expect((await lens.boundingBox())!.height).toBe(54)
  })
}

test('the compose circle sits beside the tab bar and leaves Activity and Settings', async ({
  page,
}) => {
  const compose = page.getByRole('button', { name: 'New Note', exact: true })
  expect(await compose.boundingBox()).toMatchObject({ x: 312, width: 62, height: 62 })
  expect((await compose.boundingBox())!.y).toBe(844 - 24 - 62)
  for (const name of ['Activity', 'Settings']) {
    await tab(page, name).click()
    await expect(page.locator('.phone-capture')).toHaveAttribute('data-hidden')
  }
  await tab(page, 'Notes').click()
  await expect(page.locator('.phone-capture')).not.toHaveAttribute('data-hidden')
})

test('Activity has a top bar and moves the lens to the third place', async ({ page }) => {
  await tab(page, 'Activity').click()
  const screen = page.getByRole('region', { name: 'Activity' })
  await expect(screen.getByRole('heading', { level: 1 })).toHaveText('Activity')
  await expect(tab(page, 'Activity')).toHaveAttribute('aria-current', 'page')
  const [lens, button] = await Promise.all([
    tabs(page).locator('.phone-tabbar-lens').boundingBox(),
    tab(page, 'Activity').boundingBox(),
  ])
  expect(lens!.x).toBeCloseTo(button!.x, 0)
})

const INSET = 4
const TAB = (286 - INSET * 2) / 4

async function lensInBar(page: Page) {
  const [bar, lens] = await Promise.all([
    tabs(page).boundingBox(),
    tabs(page).locator('.phone-tabbar-lens').boundingBox(),
  ])
  return {
    left: lens!.x - bar!.x,
    right: bar!.x + bar!.width - (lens!.x + lens!.width),
    top: lens!.y - bar!.y,
    bottom: bar!.y + bar!.height - (lens!.y + lens!.height),
    width: lens!.width,
    centre: lens!.x + lens!.width / 2,
  }
}

const tenths = (n: number) => Math.round(n * 10) / 10

test('the lens rests inside the bar by an even inset at the first and the last tab', async ({
  page,
}) => {
  for (const [name, left, right] of [
    ['Notes', INSET, INSET + TAB * 3],
    ['Settings', INSET + TAB * 3, INSET],
  ] as const) {
    await tab(page, name).click()
    await expect
      .poll(async () => {
        const at = await lensInBar(page)
        return [at.left, at.right, at.top, at.bottom].map(tenths)
      })
      .toEqual([left, right, INSET, INSET])
    await expect(tabs(page).locator('.phone-tabbar-lens')).toHaveCSS('border-radius', '27px')
  }
})

test('the lens stretches on its way to the last tab and never passes the bar inner edge', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await tab(page, 'Notes').click()
  await expect.poll(async () => tenths((await lensInBar(page)).left)).toBe(INSET)
  const sampling = tabs(page).evaluate(
    (bar, inset) =>
      new Promise<{ spill: number; widest: number }>((resolve) => {
        const lens = bar.querySelector('.phone-tabbar-lens')!
        const start = performance.now()
        let spill = -Infinity
        let widest = 0
        const sample = () => {
          const outer = bar.getBoundingClientRect()
          const box = lens.getBoundingClientRect()
          spill = Math.max(
            spill,
            outer.left + inset - box.left,
            box.right - (outer.right - inset),
            outer.top + inset - box.top,
            box.bottom - (outer.bottom - inset),
          )
          widest = Math.max(widest, box.width)
          if (performance.now() - start < 1200) requestAnimationFrame(sample)
          else resolve({ spill, widest })
        }
        requestAnimationFrame(sample)
      }),
    INSET,
  )
  await tab(page, 'Settings').click()
  const { spill, widest } = await sampling
  // A click lifts the lens for a moment, and the lift stays within the inset.
  expect(spill).toBeLessThanOrEqual(1)
  expect(widest).toBeGreaterThan(TAB * 1.15)
  await expect.poll(async () => tenths((await lensInBar(page)).right)).toBe(INSET)
})

test('dragging the lens along the bar follows the finger and opens the nearest tab', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const lens = tabs(page).locator('.phone-tabbar-lens')
  const notes = (await tab(page, 'Notes').boundingBox())!
  const activity = (await tab(page, 'Activity').boundingBox())!
  const y = notes.y + notes.height / 2
  await page.mouse.move(notes.x + notes.width / 2, y)
  await page.mouse.down()
  await expect(lens).toHaveAttribute('data-lifted')
  const finger = Math.round(activity.x + activity.width * 0.7)
  await page.mouse.move(finger, y, { steps: 12 })
  await expect
    .poll(async () => Math.abs((await lensInBar(page)).centre - finger))
    .toBeLessThanOrEqual(0.5)
  await page.mouse.up()
  await expect(tab(page, 'Activity')).toHaveAttribute('aria-current', 'page')
  await expect(lens).not.toHaveAttribute('data-lifted')
  await expect
    .poll(async () => Math.abs((await lensInBar(page)).centre - (activity.x + activity.width / 2)))
    .toBeLessThanOrEqual(0.5)
})

test('a drag survives the pressed tab losing its touch capture to the bar', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const notes = (await tab(page, 'Notes').boundingBox())!
  const activity = (await tab(page, 'Activity').boundingBox())!
  const y = notes.y + notes.height / 2
  await tabs(page).evaluate((nav: HTMLElement) => {
    const remember = (e: PointerEvent) => (nav.dataset['pointer'] = String(e.pointerId))
    nav.addEventListener('pointerdown', remember, { capture: true })
  })
  await page.mouse.move(notes.x + notes.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(activity.x + activity.width / 2, y, { steps: 12 })
  // Touch captures the pressed button implicitly; taking capture for the bar fires this on it.
  await tab(page, 'Notes').evaluate((button) => {
    const pointerId = Number(button.parentElement!.dataset['pointer'])
    button.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId }))
  })
  await page.mouse.up()
  await expect(tab(page, 'Activity')).toHaveAttribute('aria-current', 'page')
})

// Lifted 8%, the 54 pt lens keeps this much of the bar around it on every side.
const LIFTED_MARGIN = INSET - (54 * 0.08) / 2

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`a held lens stays concentric with the bar at both ends, ${viewport.width} wide`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const bar = (await tabs(page).boundingBox())!
    const y = bar.y + bar.height / 2
    for (const [name, side, past] of [
      ['Notes', 'left', bar.x - 30],
      ['Settings', 'right', bar.x + bar.width + 30],
    ] as const) {
      const box = (await tab(page, name).boundingBox())!
      await page.mouse.move(box.x + box.width / 2, y)
      await page.mouse.down()
      const offBy = (margin: number) => async () => {
        const at = await lensInBar(page)
        return Math.max(...[at[side], at.top, at.bottom].map((m) => Math.abs(m - margin)))
      }
      await expect.poll(offBy(LIFTED_MARGIN)).toBeLessThanOrEqual(0.1)
      await page.mouse.move(past, y, { steps: 8 })
      await expect.poll(offBy(LIFTED_MARGIN)).toBeLessThanOrEqual(0.1)
      await page.mouse.up()
      await expect(tab(page, name)).toHaveAttribute('aria-current', 'page')
      await expect.poll(offBy(INSET)).toBeLessThanOrEqual(0.1)
    }
  })
}

async function dragAcross(page: Page, from: string, to: string) {
  const start = (await tab(page, from).boundingBox())!
  const end = (await tab(page, to).boundingBox())!
  const y = start.y + start.height / 2
  await page.mouse.move(start.x + start.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(end.x + end.width / 2, y, { steps: 10 })
  await page.mouse.up()
  await expect(tab(page, to)).toHaveAttribute('aria-current', 'page')
}

test('a drag leaves the next keyboard press on a tab working', async ({ page }) => {
  await dragAcross(page, 'Notes', 'Activity')
  await tab(page, 'Settings').focus()
  await page.keyboard.press('Enter')
  await expect(tab(page, 'Settings')).toHaveAttribute('aria-current', 'page')
  await dragAcross(page, 'Settings', 'Library')
  await tab(page, 'Notes').focus()
  await page.keyboard.press('Space')
  await expect(tab(page, 'Notes')).toHaveAttribute('aria-current', 'page')
})

test('a press released off the bar lets the lens down and the bar still drags', async ({
  page,
}) => {
  const lens = tabs(page).locator('.phone-tabbar-lens')
  for (const offBar of [
    (box: { x: number; y: number }) => ({ x: box.x, y: box.y - 120 }),
    () => ({ x: 200, y: 300 }),
  ]) {
    const notes = (await tab(page, 'Notes').boundingBox())!
    const centre = { x: notes.x + notes.width / 2, y: notes.y + notes.height / 2 }
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.down()
    await expect(lens).toHaveAttribute('data-lifted')
    const to = offBar(centre)
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    await expect(lens).not.toHaveAttribute('data-lifted')
    await expect(tab(page, 'Library')).toHaveAttribute('aria-current', 'page')
  }
  await dragAcross(page, 'Library', 'Settings')
  await expect(lens).not.toHaveAttribute('data-lifted')
  await tab(page, 'Library').click()
  await expect(tab(page, 'Library')).toHaveAttribute('aria-current', 'page')
})

test('a drag the bar is resized under is cancelled', async ({ page }) => {
  const lens = tabs(page).locator('.phone-tabbar-lens')
  const notes = (await tab(page, 'Notes').boundingBox())!
  const activity = (await tab(page, 'Activity').boundingBox())!
  const y = notes.y + notes.height / 2
  await page.mouse.move(notes.x + notes.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(activity.x + activity.width * 0.7, y, { steps: 10 })
  await page.setViewportSize({ width: 844, height: 390 })
  await expect(lens).not.toHaveAttribute('data-lifted')
  await page.mouse.up()
  await expect(tab(page, 'Library')).toHaveAttribute('aria-current', 'page')
  const library = (await tab(page, 'Library').boundingBox())!
  await expect
    .poll(async () => Math.abs((await lensInBar(page)).centre - (library.x + library.width / 2)))
    .toBeLessThanOrEqual(0.5)
  await tab(page, 'Activity').click()
  await expect(tab(page, 'Activity')).toHaveAttribute('aria-current', 'page')
})

test('the capture sheet grows from the circle, 374 by 440, and goes back', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'New Note' })
  await expect(sheet).toBeVisible()
  // 440 at the default text size, and the test browser's system text is smaller.
  const height = 440 * (await barScale(page))
  await expect
    .poll(async () => {
      const box = (await sheet.boundingBox())!
      return [box.x, box.width, Math.round(box.height), Math.round(box.y)]
    })
    .toEqual([8, 374, Math.round(height), Math.round(844 - 8 - height)])
  await expect(sheet).toHaveCSS('border-radius', '34px')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toHaveCount(0)
  await expect
    .poll(async () => page.locator('.phone-capture').boundingBox())
    .toMatchObject({ x: 312, width: 62, height: 62 })
})

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

  for (const [ending, end] of [
    ['loses its capture', 'lostpointercapture'],
    ['is taken by the system', 'blur'],
  ] as const) {
    test(`a back swipe that ${ending} springs back and leaves the screen usable`, async ({
      page,
    }) => {
      await openTemplates(page)
      await page.waitForTimeout(600)
      const zone = page.getByTestId('phone-back-zone')
      const box = (await zone.boundingBox())!
      await page.mouse.move(4, box.y + 100)
      await page.mouse.down()
      await page.mouse.move(92, box.y + 100, { steps: 8 })
      await expect(topLayer(page)).toHaveAttribute('data-dragging', 'true')
      await zone.evaluate((el, type) => {
        const target = type === 'blur' ? window : el
        target.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true }))
      }, end)
      await expect(topLayer(page)).not.toHaveAttribute('data-dragging')
      await expect.poll(async () => (await topLayer(page).boundingBox())?.x).toBe(0)
      await page.mouse.up()
      await expect(page.getByRole('region', { name: 'Templates' })).toBeVisible()
      await page.getByRole('button', { name: 'Back' }).click()
      await expect(zone).toHaveCount(0)
    })
  }

  test('Back pressed mid-swipe leaves the screen below where it belongs', async ({ page }) => {
    await openTemplates(page)
    await page.waitForTimeout(600)
    const box = (await page.getByTestId('phone-back-zone').boundingBox())!
    await page.mouse.move(4, box.y + 100)
    await page.mouse.down()
    await page.mouse.move(92, box.y + 100, { steps: 8 })
    await page.getByRole('button', { name: 'Back' }).evaluate((el) => (el as HTMLElement).click())
    await expect(page.getByTestId('phone-back-zone')).toHaveCount(0)
    await expect.poll(async () => (await topLayer(page).boundingBox())?.x).toBe(0)
    await expect(topLayer(page)).not.toHaveAttribute('data-dragging')
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
      expect(await cssPx(title, 'fontSize')).toBeCloseTo(22 * (await barScale(page)), 1)
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
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  const screen = page.getByRole('region', { name: 'Library' })
  const card = screen.locator('.phone-card').first()
  await expect(card).toHaveCSS('border-radius', '22px')
  expect((await card.boundingBox())!.x).toBe(16)
  const row = card.locator('.phone-grouped-open').first()
  const box = (await row.boundingBox())!
  expect(box.x).toBe(20)
  expect(box.height).toBeGreaterThanOrEqual(44)
  await expect(row).toHaveCSS('padding-left', '12px')
  const head = screen.locator('.phone-list-head-name').first()
  expect((await head.boundingBox())!.x).toBe(26)
  expect(await cssPx(head, 'fontSize')).toBeCloseTo(14 * (await textScale(page)), 1)
  await expect(head).toHaveCSS('font-weight', '500')
  await expect(head).toHaveCSS('text-transform', 'none')
})

test('counts use the UI font with tabular figures', async ({ page }) => {
  const count = page.getByRole('region', { name: 'Library' }).locator('.phone-figures').first()
  await expect(count).toHaveCSS('font-variant-numeric', 'tabular-nums')
  await expect(count).not.toHaveCSS('font-family', /monospace/)
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
