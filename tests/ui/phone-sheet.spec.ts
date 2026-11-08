import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { openPhoneNote } from './phone'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

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

async function openStatus(page: Page): Promise<Locator> {
  const note = await openNoteScreen(page)
  await note.locator('.phone-chip-target').nth(1).click()
  return page.getByRole('dialog', { name: 'Status' })
}

test('a sheet drag that loses its capture settles back open', async ({ page }) => {
  const sheet = await openStatus(page)
  await expect(sheet).toBeVisible()
  const handle = sheet.locator('.phone-sheet-handle')
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + 30, box.y + 80, { steps: 8 })
  await expect(sheet).toHaveAttribute('data-dragging')
  await handle.evaluate((el) =>
    el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1, bubbles: true })),
  )
  await expect(sheet).not.toHaveAttribute('data-dragging')
  await page.mouse.up()
  await expect(sheet).toBeVisible()
  await expect
    .poll(() => sheet.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42))
    .toBe(0)
})

test('a sheet taller than the screen scrolls inside and stays whole', async ({ page }) => {
  const sheet = await openStatus(page)
  await page.setViewportSize({ width: 390, height: 240 })
  await expectWholeSheet(page, sheet, sheet.getByRole('button').last())
})

test('the note pickers are whole, on the note screen', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await openPhoneNote(page)
  const note = page.locator('section.phone-screen:has(.phone-note-scroll)')
  await expect(note.locator('.cm-content')).toBeAttached()

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
  await openPhoneNote(page)
  const note = page.locator('section.phone-screen:has(.phone-note-scroll)')
  await expect(note.locator('.cm-content')).toBeAttached()
  return note
}

test('a sheet takes the keyboard, keeps Tab inside, and Escape gives it back to its trigger', async ({
  page,
}) => {
  const note = await openNoteScreen(page)
  const trigger = note.locator('.phone-chip-target').nth(1)
  await trigger.focus()
  await page.keyboard.press('Enter')
  const status = page.getByRole('dialog', { name: 'Status' })
  await expect(status).toBeVisible()
  await expect.poll(() => focusIn(status)).toBe(true)
  await expectTabStaysIn(page, status, 12)
  const behind = () => trigger.evaluate((el) => el.closest('[inert]') !== null)
  expect(await behind()).toBe(true)

  await page.keyboard.press('Escape')
  await expect(status).toHaveCount(0)
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
