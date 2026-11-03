import type { Locator, Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })

async function expectWholeSheet(page: Page, sheet: Locator, last: Locator): Promise<void> {
  await expect(sheet).toBeVisible()
  await expect
    .poll(() => sheet.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42))
    .toBe(0)
  const size = page.viewportSize()!
  const dim = (await page.locator('.phone-sheet-dim').boundingBox())!
  expect(dim).toEqual({ x: 0, y: 0, width: size.width, height: size.height })
  const box = (await sheet.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeCloseTo(size.height, 0)
  await last.scrollIntoViewIfNeeded()
  const control = (await last.boundingBox())!
  expect(control.y + control.height).toBeLessThanOrEqual(size.height)
  for (const [x, y] of [
    [box.x + box.width / 2, box.y + box.height - 2],
    [control.x + control.width / 2, control.y + control.height / 2],
  ] as const) {
    const inside = await sheet.evaluate(
      (el, [px, py]) => el.contains(el.ownerDocument.elementFromPoint(px!, py!)),
      [x, y],
    )
    expect(inside).toBe(true)
  }
}

const seedTrial = (page: Page) =>
  page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      licence_get: () => ({
        gated: true,
        state: 'none',
        code: null,
        id: null,
        licensee: null,
        plan: null,
        trial: { state: 'running', endsAt: Date.now() + 86_400_000, code: null },
      }),
    }
  })

async function openTrial(page: Page): Promise<Locator> {
  await seedTrial(page)
  await page.goto('/')
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  await page.locator('.phone-app-row').click()
  return page.getByRole('dialog', { name: 'Trial' })
}

test('the trial sheet covers the tab bar and is whole, its Done reachable', async ({ page }) => {
  const sheet = await openTrial(page)
  const done = sheet.getByRole('button', { name: 'Done' })
  await expectWholeSheet(page, sheet, done)
  await done.click()
  await expect(sheet).toHaveCount(0)
})

test('a sheet taller than the screen scrolls inside and stays whole', async ({ page }) => {
  const sheet = await openTrial(page)
  await page.setViewportSize({ width: 390, height: 240 })
  const done = sheet.getByRole('button', { name: 'Done' })
  await expectWholeSheet(page, sheet, done)
})

test('note info and the note pickers are whole, on the note screen', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await tabs(page).getByRole('button', { name: 'Notes' }).click()
  await page.locator('[data-section="recent"] .phone-note-open').first().click()
  const note = page.locator('section.phone-screen:has(.phone-note-scroll)')
  await expect(note.locator('.cm-content')).toBeAttached()

  await note.getByRole('button', { name: 'Note Info' }).click()
  const info = page.getByRole('dialog', { name: 'Note Info' })
  await expectWholeSheet(page, info, info.getByRole('button', { name: 'Move to Trash' }))
  await info.getByRole('button', { name: 'Close' }).click()
  await expect(info).toHaveCount(0)

  await note.locator('.phone-chip-target').nth(1).click()
  const status = page.getByRole('dialog', { name: 'Status' })
  await expectWholeSheet(page, status, status.getByRole('button').last())
  await status.getByRole('button', { name: 'Close' }).click()
  await expect(status).toHaveCount(0)

  await note.locator('.phone-chip-target').first().click()
  const move = page.getByRole('dialog', { name: 'Move to…' })
  await expectWholeSheet(page, move, move.getByRole('button').last())
})

const focusIn = (sheet: Locator) =>
  sheet.evaluate((el) => {
    const active = el.ownerDocument.activeElement
    return active !== null && el.contains(active)
  })

async function expectTabStaysIn(page: Page, sheet: Locator, presses: number): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab')
    expect(await focusIn(sheet)).toBe(true)
  }
  await page.keyboard.press('Shift+Tab')
  expect(await focusIn(sheet)).toBe(true)
}

async function openNoteScreen(page: Page): Promise<Locator> {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await tabs(page).getByRole('button', { name: 'Notes' }).click()
  await page.locator('[data-section="recent"] .phone-note-open').first().click()
  const note = page.locator('section.phone-screen:has(.phone-note-scroll)')
  await expect(note.locator('.cm-content')).toBeAttached()
  return note
}

test('a sheet takes the keyboard, keeps Tab inside, and Escape gives it back to its trigger', async ({
  page,
}) => {
  const note = await openNoteScreen(page)
  const trigger = note.getByRole('button', { name: 'Note Info' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const info = page.getByRole('dialog', { name: 'Note Info' })
  await expect(info).toBeVisible()
  await expect.poll(() => focusIn(info)).toBe(true)
  await expectTabStaysIn(page, info, 12)
  const behind = () => trigger.evaluate((el) => el.closest('[inert]') !== null)
  expect(await behind()).toBe(true)

  await page.keyboard.press('Escape')
  await expect(info).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(await behind()).toBe(false)
})

test('the tag sheet keeps the keyboard through its colour picker; Escape closes the picker first', async ({
  page,
}) => {
  const note = await openNoteScreen(page)
  const trigger = note.locator('.phone-chip-target:has(.phone-chip-dashed)')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const sheet = page.getByRole('dialog', { name: 'Tags' })
  await expect.poll(() => focusIn(sheet)).toBe(true)
  await sheet.getByRole('textbox', { name: 'Tag name' }).fill('fresh')
  await sheet.getByRole('radio', { name: 'Custom Color' }).focus()
  await page.keyboard.press('Enter')
  const hue = sheet.getByRole('slider', { name: 'Hue' })
  await expect(hue).toBeVisible()
  await expect.poll(() => focusIn(sheet)).toBe(true)
  await expectTabStaysIn(page, sheet, 6)

  await page.keyboard.press('Escape')
  await expect(hue).toHaveCount(0)
  await expect(sheet).toBeVisible()
  await expect.poll(() => focusIn(sheet)).toBe(true)

  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
