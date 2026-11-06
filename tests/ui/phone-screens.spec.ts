import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })
const list = (page: Page) => page.getByRole('region', { name: 'All Notes' })
const rows = (page: Page) => list(page).locator('.phone-note-row')
const recent = (page: Page) => list(page).locator('[data-section="recent"] .phone-note-row')
const section = (page: Page, key: string) => list(page).locator(`[data-section="${key}"]`)

// Startup writes the welcome note unpinned, pins it, then writes the example: the list has settled once both sections show.
async function openNotes(page: Page): Promise<void> {
  await tabs(page).getByRole('button', { name: 'Notes' }).click()
  await expect(section(page, 'pinned')).toBeVisible()
  await expect(recent(page).first()).toBeVisible()
}

/** Seeds the list with notes that the sections sort out, through the UI. */
async function capture(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'New Note' })
  await sheet.getByLabel('Title').fill(title)
  await sheet.getByRole('button', { name: 'Save note' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(rows(page).filter({ hasText: title })).toHaveCount(1)
}

async function swipeRow(page: Page, index: number, by: number): Promise<void> {
  const box = (await recent(page).nth(index).boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 20 - by, y, { steps: 14 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await expect(tabs(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the note list shows rows and a title with no count, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await openNotes(page)
    await expect(list(page).getByRole('heading', { level: 1 })).toHaveText('All Notes')
    await expect(list(page).getByText(/^\d+ notes$/)).toHaveCount(0)
    const row = (await recent(page).first().locator('.phone-note-open').boundingBox())!
    expect(row.height).toBeGreaterThanOrEqual(62)
    expect(row.height).toBeLessThan(70)
  })
}

test('a row draws its status mark at 20, its text at 52 to 370, with no avatar', async ({
  page,
}) => {
  await openNotes(page)
  const row = recent(page).first()
  await expect(list(page).locator('.phone-avatar')).toHaveCount(0)
  expect((await row.locator('.phone-note-mark').boundingBox())!).toMatchObject({
    x: 20,
    width: 20,
    height: 20,
  })
  const title = (await row.locator('.phone-note-title').boundingBox())!
  const time = (await row.locator('.phone-note-time').boundingBox())!
  expect(title.x).toBe(52)
  expect(time.x + time.width).toBe(370)
  await expect(row.locator('.phone-note-title')).toHaveCSS('font-weight', '400')
  const scale = await page
    .locator('.phone-app')
    .evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--phone-text-scale') || 1))
  const fontSize = (selector: string) =>
    row.locator(selector).evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
  expect(await fontSize('.phone-note-title')).toBeCloseTo(17 * scale, 1)
  expect(await fontSize('.phone-note-time')).toBeCloseTo(14 * scale, 1)
  await expect(row.locator('.phone-note-excerpt')).toHaveCSS('white-space', 'nowrap')
})

test('a section head has a mono count and collapses its rows', async ({ page }) => {
  await openNotes(page)
  const head = section(page, 'recent').getByRole('button', { name: /Recent/ })
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(head.locator('.phone-figures')).toHaveText(/^\d+$/)
  const chevron = head.locator('.phone-list-head-chevron')
  await expect(chevron).toHaveCSS('transform', 'none')
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(recent(page).first()).toBeHidden()
  await expect(chevron).not.toHaveCSS('transform', 'none')
  await head.click()
  await expect(recent(page).first()).toBeVisible()
})

test('Completed starts collapsed behind Show more, which opens it', async ({ page }) => {
  await openNotes(page)
  await swipeRow(page, 0, 370)
  const completed = section(page, 'completed')
  const more = completed.getByRole('button', {
    name: /^Show more \(1 completed hidden\)$/,
  })
  await expect(more).toBeVisible()
  await expect(completed.locator('.phone-note-row').first()).toBeHidden()
  await more.click()
  await expect(more).toHaveCount(0)
  await expect(completed.locator('.phone-note-row').first()).toBeVisible()
})

async function chooseFilter(page: Page, name: RegExp): Promise<void> {
  await list(page).getByRole('button', { name: 'Status filter' }).click()
  await list(page).getByRole('menuitemradio', { name }).click()
}

test('the filter menu offers four choices and closes when tapped outside', async ({ page }) => {
  await openNotes(page)
  await list(page).getByRole('button', { name: 'Status filter' }).click()
  await expect(list(page).getByRole('menuitemradio')).toHaveCount(4)
  await expect(list(page).getByRole('menuitemradio', { name: /All/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await list(page)
    .getByRole('button', { name: 'Close' })
    .click({ position: { x: 20, y: 400 } })
  await expect(list(page).getByRole('menu')).toHaveCount(0)
})

test('the filter keeps only notes in that status', async ({ page }) => {
  await openNotes(page)
  await chooseFilter(page, /Done/)
  await list(page).getByRole('button', { name: 'Status filter' }).click()
  await expect(list(page).getByRole('menuitemradio', { name: /Done/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await list(page)
    .getByRole('button', { name: 'Close' })
    .click({ position: { x: 20, y: 400 } })
  await expect(section(page, 'recent')).toHaveCount(0)
  for (const mark of await list(page).locator('.phone-note-mark').all())
    await expect(mark).toHaveAttribute('aria-label', 'Completed')
})

test('a row swiped past half stays open with its three actions', async ({ page }) => {
  await openNotes(page)
  await swipeRow(page, 0, 130)
  const row = recent(page).first()
  const actions = row.locator('.phone-swipe-action')
  await expect(actions).toHaveCount(3)
  await expect(actions.nth(2)).toBeInViewport()
  await expect(row.locator('.phone-note-content')).toHaveAttribute('data-raised')
  await expect
    .poll(async () => row.locator('.phone-note-open').boundingBox())
    .toMatchObject({ x: -196 })
  const capsule = (await actions.nth(2).locator('.phone-swipe-capsule').boundingBox())!
  expect(capsule).toMatchObject({ x: 328, width: 52, height: 34 })
  await expect(row.locator('.phone-note-content')).toHaveCSS(
    'transform',
    'matrix(1, 0, 0, 1, -196, 0)',
  )
})

test('tapping another row first closes the open one, and opens nothing', async ({ page }) => {
  await openNotes(page)
  await capture(page, 'Second row')
  await swipeRow(page, 0, 130)
  const content = recent(page).first().locator('.phone-note-content')
  await expect(content).toHaveAttribute('data-raised')
  await recent(page).nth(1).locator('.phone-note-open').click()
  await expect(content).not.toHaveAttribute('data-raised')
  await expect(list(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Note Info' })).toHaveCount(0)
})

test('a row swiped past 270 completes its note and moves it to Completed', async ({ page }) => {
  await openNotes(page)
  const title = (await recent(page).first().locator('.phone-note-title').textContent())!
  // Past 196 the drag meets the 0.6 rubber band, so 270 needs about 320 of travel.
  await swipeRow(page, 0, 370)
  const moved = section(page, 'completed').locator('.phone-note-row').filter({ hasText: title })
  await expect(moved.locator('.phone-note-mark')).toHaveAttribute('aria-label', 'Completed')
})

test('a row swipe that loses its capture closes, and the list still opens notes', async ({
  page,
}) => {
  await openNotes(page)
  const row = recent(page).first()
  const content = row.locator('.phone-note-content')
  const box = (await row.boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 160, y, { steps: 14 })
  await expect(content).toHaveAttribute('data-dragging')
  await content.evaluate((el) =>
    el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true })),
  )
  await expect(content).not.toHaveAttribute('data-dragging')
  await expect(content).not.toHaveAttribute('data-raised')
  await page.mouse.up()
  await row.locator('.phone-note-open').click()
  await expect(page.getByRole('button', { name: 'Note Info' })).toBeVisible()
})

test('a vertical drag on a row never swipes', async ({ page }) => {
  await openNotes(page)
  const box = (await recent(page).first().boundingBox())!
  await page.mouse.move(box.x + 200, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 190, box.y + 120, { steps: 8 })
  await page.mouse.up()
  await expect(recent(page).first().locator('.phone-note-content')).not.toHaveAttribute(
    'data-raised',
  )
})

test.describe('under Reduce Motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } })

  test('a peek only crossfades', async ({ page }) => {
    await openNotes(page)
    await recent(page)
      .first()
      .getByRole('button', { name: /^Actions for / })
      .evaluate((el) => (el as HTMLElement).click())
    const card = page.locator('.phone-peek-card')
    await expect(card).toBeVisible()
    const seen = await card.evaluate((el) => ({
      transform: getComputedStyle(el).transform,
      property: getComputedStyle(el).transitionProperty,
    }))
    expect(seen).toEqual({ transform: 'none', property: 'opacity' })
  })
})

test('at twice the text size every peek action is on screen', async ({ page }) => {
  await openNotes(page)
  await page.locator('.phone-app').evaluate((app) => {
    const shell = app
    shell.style.setProperty('--phone-text-scale', '2')
    shell.dataset['textSize'] = 'accessibility'
  })
  await recent(page)
    .first()
    .getByRole('button', { name: /^Actions for / })
    .evaluate((el) => (el as HTMLElement).click())
  const menu = page.locator('.phone-peek-menu')
  await expect(menu).toBeVisible()
  const height = await page.evaluate(() => innerHeight)
  const drawn = (await menu.boundingBox())!
  expect(drawn.y + drawn.height).toBeLessThanOrEqual(height)
  // The excerpt gives way first: the title is never cut.
  const title = page.locator('.phone-peek-card .phone-peek-title')
  {
    expect(await title.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    const card = (await page.locator('.phone-peek-card').boundingBox())!
    const box = (await title.boundingBox())!
    expect(box.y + box.height).toBeLessThanOrEqual(card.y + card.height + 1)
  }
  const items = menu.getByRole('menuitem')
  await expect(items.first()).toBeVisible()
  for (const item of await items.all()) {
    await item.evaluate((el) => el.scrollIntoView({ block: 'nearest' }))
    const box = (await item.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
  }
})

test.describe('the peek with motion', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('animates only transforms and opacity, with a fixed blur that fades in', async ({
    page,
  }) => {
    await openNotes(page)
    const actions = recent(page)
      .first()
      .getByRole('button', { name: /^Actions for / })
    // Sampled in the page, in the frames right after it opens, while the transitions run.
    const running = await actions.evaluate(async (button) => {
      ;(button as HTMLElement).click()
      const frame = () => new Promise((done) => requestAnimationFrame(done))
      let layer: Element | null = null
      while (!layer) {
        await frame()
        layer = document.querySelector('.phone-peek-layer[data-shown]')
      }
      await frame()
      const parts = [...layer.querySelectorAll<HTMLElement>('.phone-peek-dim, .phone-peek > *')]
      return {
        properties: [
          ...new Set(
            document
              .getAnimations()
              .filter((a) => layer.contains((a.effect as KeyframeEffect | null)?.target ?? null))
              .map((a) => (a instanceof CSSTransition ? a.transitionProperty : a.constructor.name)),
          ),
        ],
        declared: parts.flatMap((part) => getComputedStyle(part).transitionProperty.split(', ')),
        promoted: getComputedStyle(layer.querySelector('.phone-peek-card')!).willChange,
        blur: getComputedStyle(layer.querySelector('.phone-peek-dim')!).backdropFilter,
        glass: [...layer.querySelectorAll<HTMLElement>('.phone-peek > .phone-glass')].map(
          (bar) => getComputedStyle(bar).backdropFilter,
        ),
      }
    })
    expect(running.properties.length).toBeGreaterThan(0)
    for (const property of [...running.properties, ...running.declared])
      expect(['transform', 'opacity']).toContain(property)
    expect(running.promoted).toBe('transform, opacity')
    expect(running.blur).toBe('blur(16px)')
    expect(running.glass).toEqual(['none', 'none'])
    const layer = page.locator('.phone-peek-layer')
    await expect(layer).toHaveAttribute('data-settled', 'true')
    expect(
      await layer.locator('.phone-peek-card').evaluate((el) => getComputedStyle(el).willChange),
    ).toBe('auto')
  })
})

test('a long press peeks, and the status bar sets the status', async ({ page }) => {
  await openNotes(page)
  const box = (await recent(page).first().boundingBox())!
  await page.mouse.move(box.x + 100, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(600)
  await page.mouse.up()
  const peek = page.getByRole('group', { name: 'Set Status' })
  await expect(peek).toBeVisible()
  for (const name of ['Open', 'Pin', 'Move to…', 'Move to Trash']) {
    await expect(
      page.getByRole('menuitem', { name, exact: true }).locator('svg, .icon'),
    ).toHaveCount(1)
  }
  await peek.getByRole('button', { name: 'On Hold' }).click()
  await expect(peek).toHaveCount(0)
  await chooseFilter(page, /On Hold/)
  await expect(rows(page)).not.toHaveCount(0)
})

test('the row actions are offered without a gesture', async ({ page }) => {
  await openNotes(page)
  await recent(page)
    .first()
    .getByRole('button', { name: /^Actions for / })
    .evaluate((el) => (el as HTMLElement).click())
  await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible()
})

test.describe('the undo toast', () => {
  const toast = (page: Page) => page.getByRole('status')
  const undo = (page: Page) => toast(page).getByRole('button', { name: 'Undo' })
  const recentTitles = (page: Page) => recent(page).locator('.phone-note-title').allTextContents()

  test('rises 100 above the bottom after a complete, and Undo keeps the note in its place', async ({
    page,
  }) => {
    await openNotes(page)
    await capture(page, 'Second row')
    const before = await recentTitles(page)
    await swipeRow(page, 1, 370)
    await expect(toast(page)).toContainText('Marked completed')
    await expect(section(page, 'completed')).toBeVisible()
    await expect
      .poll(async () => {
        const box = (await toast(page).boundingBox())!
        return Math.round(box.y + box.height)
      })
      .toBe(844 - 100)
    const target = (await undo(page).boundingBox())!
    expect(target.height).toBeGreaterThanOrEqual(44)
    await undo(page).click()
    await expect(toast(page)).toBeHidden()
    await expect(section(page, 'completed')).toHaveCount(0)
    await expect.poll(() => recentTitles(page)).toEqual(before)
  })

  test('says Moved to Trash after the swipe capsule, and Undo restores the row', async ({
    page,
  }) => {
    await openNotes(page)
    const before = await recentTitles(page)
    await swipeRow(page, 0, 130)
    await recent(page).first().locator('.phone-swipe-action[data-action="trash"]').click()
    await expect(toast(page)).toContainText('Moved to Trash')
    await expect.poll(() => recentTitles(page)).not.toEqual(before)
    await undo(page).click()
    await expect.poll(() => recentTitles(page)).toEqual(before)
  })

  test('follows the peek menu and its status bar', async ({ page }) => {
    await openNotes(page)
    const actions = recent(page)
      .first()
      .getByRole('button', { name: /^Actions for / })
    await actions.evaluate((el) => (el as HTMLElement).click())
    await page
      .getByRole('group', { name: 'Set Status' })
      .getByRole('button', { name: 'Completed' })
      .click()
    await expect(toast(page)).toContainText('Marked completed')
    await undo(page).click()
    await actions.evaluate((el) => (el as HTMLElement).click())
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
    await expect(toast(page)).toContainText('Moved to Trash')
  })

  test('outlives the note screen when trashing from its info sheet', async ({ page }) => {
    await openNotes(page)
    const title = (await recent(page).first().locator('.phone-note-title').textContent())!
    await recent(page).first().locator('.phone-note-open').click()
    await page.getByRole('button', { name: 'Note Info' }).click()
    await page
      .getByRole('dialog', { name: 'Note Info' })
      .getByRole('button', { name: 'Move to Trash' })
      .click()
    await expect(toast(page)).toContainText('Moved to Trash')
    await undo(page).click()
    await expect(recent(page).filter({ hasText: title })).toHaveCount(1)
  })

  test('hides by itself after 4 s, leaving the action done', async ({ page }) => {
    await openNotes(page)
    await page.clock.install()
    await swipeRow(page, 0, 370)
    await expect(toast(page)).toBeVisible()
    await page.clock.runFor(2900)
    await expect(toast(page)).toBeVisible()
    await page.clock.runFor(1500)
    await expect(toast(page)).toBeHidden()
    await expect(section(page, 'completed')).toBeVisible()
  })

  test('a second action replaces it and the first stays done', async ({ page }) => {
    await openNotes(page)
    await capture(page, 'Second row')
    await swipeRow(page, 0, 370)
    await expect(toast(page)).toContainText('Marked completed')
    await swipeRow(page, 0, 130)
    await recent(page).first().locator('.phone-swipe-action[data-action="trash"]').click()
    await expect(toast(page)).toContainText('Moved to Trash')
    await undo(page).click()
    await expect(section(page, 'completed')).toBeVisible()
  })
})

test('capture saves a note to the top of Recent, opening it first', async ({ page }) => {
  await openNotes(page)
  await section(page, 'recent')
    .getByRole('button', { name: /Recent/ })
    .click()
  await capture(page, 'Relay retention')
  await expect(recent(page).first()).toBeVisible()
  await expect(recent(page).first()).toContainText('Relay retention')
})

test('a note captured from the Library lands in Recent of All Notes', async ({ page }) => {
  await openNotes(page)
  await tabs(page).getByRole('button', { name: 'Library' }).click()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'New Note' })
  await sheet.getByLabel('Title').fill('From the Library')
  await sheet.getByRole('button', { name: 'Save note' }).click()
  await expect(recent(page).first()).toContainText('From the Library')
  await expect(tabs(page).getByRole('button', { name: 'Notes' })).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test.describe('with motion', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('a saved note flies in and flashes, and the rows below shift', async ({ page }) => {
    await openNotes(page)
    await capture(page, 'Flying in')
    const row = recent(page).filter({ hasText: 'Flying in' })
    await expect(row).toHaveAttribute('data-arrived')
    const names = await row.evaluate((el) => getComputedStyle(el).animationName)
    expect(names).toContain('phone-arrive')
    expect(names).toContain('phone-flash')
    const below = await recent(page)
      .nth(1)
      .evaluate((el) => getComputedStyle(el).animationName)
    expect(below).toBe('phone-shift')
    await expect(row).not.toHaveAttribute('data-arrived')
  })
})

test('Settings lists its sections and opens a pane', async ({ page }) => {
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings.getByRole('button', { name: /Editing/ })).toBeVisible()
  await settings.getByRole('button', { name: /Appearance/ }).click()
  await expect(page.locator('section.phone-screen[aria-label="Appearance"]')).toBeVisible()
})

async function openPane(page: Page, name: string) {
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('region', { name: 'Settings' })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  const pane = page.locator(`section.phone-screen[aria-label="${name}"]`)
  await expect(pane.locator('.settings-section')).toBeAttached()
  return pane
}

test('Appearance on a phone has its own interface control and no system accent', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  await expect(pane.getByText('Color Scheme')).toBeVisible()
  await expect(pane.getByText('Interface style')).toHaveCount(0)
  await expect(pane.getByText('Use the System Accent Color')).toHaveCount(0)
})

test('General on a phone leaves out the menu bar, updates and command line tool', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.devotIpcMocks = {
      ...window.devotIpcMocks,
      crash_reports_get: { available: true, on: false },
    }
  })
  await page.reload()
  const pane = await openPane(page, 'General')
  for (const title of ['Menu Bar', 'Updates', 'Command Line']) {
    await expect(pane.getByRole('heading', { name: title })).toHaveCount(0)
  }
})

test('a phone Settings row shows its select value beside its label, in iPhone words', async ({
  page,
}) => {
  const pane = await openPane(page, 'Editing')
  const field = pane.getByRole('combobox', { name: 'Unordered List Bullet' })
  const label = pane.getByText('Unordered List Bullet', { exact: true })
  await expect(field).toBeVisible()
  const value = field.locator('xpath=..').locator('.select-value')
  const [fieldBox, labelBox, valueBox] = await Promise.all([
    field.boundingBox(),
    label.boundingBox(),
    value.boundingBox(),
  ])
  expect(valueBox!.x).toBeGreaterThan(labelBox!.x + labelBox!.width)
  expect(valueBox!.y).toBeLessThan(labelBox!.y + labelBox!.height)
  expect(fieldBox!.height).toBeGreaterThanOrEqual(44)
  await expect(pane.getByText('These settings apply only on this iPhone.')).toBeVisible()
})

test('no Settings or Library card clips its rows', async ({ page }) => {
  for (const tab of ['Settings', 'Library']) {
    await tabs(page).getByRole('button', { name: tab }).click()
    const cards = page.getByRole('region', { name: tab }).locator('.phone-card')
    await expect(cards.first()).toBeVisible()
    for (const card of await cards.all()) {
      const { client, content } = await card.evaluate((el) => ({
        client: el.clientHeight,
        content: el.scrollHeight,
      }))
      expect(content, tab).toBeLessThanOrEqual(client)
    }
  }
})

test('every enabled button on the note list is at least 44 points', async ({ page }) => {
  await openNotes(page)
  for (const button of await list(page).locator('button:visible:not([disabled])').all()) {
    if (await button.evaluate((el) => el.classList.contains('phone-visually-hidden'))) continue
    const box = await button.boundingBox()
    if (!box || box.width === 0) continue
    expect(box.height, (await button.getAttribute('aria-label')) ?? '').toBeGreaterThanOrEqual(44)
  }
})
