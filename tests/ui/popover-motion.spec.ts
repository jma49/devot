import type { Locator, Page } from '@playwright/test'
import { expect, openApp, statusPicker, test, type TestWindow } from './fixtures'

async function newNote(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(statusPicker(page)).toBeVisible()
}

const popover = (page: Page) => page.locator('.picker-popover:not([data-closing])')

test('a dropdown is at least 220 px wide, grows in and keeps to the window', async ({ page }) => {
  await newNote(page)
  await statusPicker(page).click()
  const list = popover(page)
  await expect(list).toBeVisible()
  const box = (await list.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(220)
  expect(await list.evaluate((el) => getComputedStyle(el).animationName)).toBe('popover-in')
  expect(await list.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0.15s')
  const view = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(8)
  expect(box.x + box.width).toBeLessThanOrEqual(view.width - 8)
  expect(box.y + box.height).toBeLessThanOrEqual(view.height - 8)
})

test('a dropdown near the bottom opens over its button and stays inside the margin', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 420 })
  await newNote(page)
  const button = (await statusPicker(page).boundingBox())!
  await page.evaluate(() => {
    ;(globalThis as unknown as { scrollTo(x: number, y: number): void }).scrollTo(0, 0)
  })
  await statusPicker(page).click()
  const list = popover(page)
  await expect(list).toBeVisible()
  const box = (await list.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(8)
  expect(box.y + box.height).toBeLessThanOrEqual(420 - 8)
  const side = await list.getAttribute('data-side')
  if (side === 'above') expect(box.y + box.height).toBeLessThanOrEqual(button.y)
})

test('a row under the pointer is tinted without taking the keyboard highlight', async ({
  page,
}) => {
  await newNote(page)
  await statusPicker(page).click()
  const rows = page.getByRole('listbox', { name: 'Status' }).getByRole('option')
  const last = rows.last()
  await last.hover()
  await expect(last).toHaveAttribute('aria-selected', 'false')
  const tint = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor)
  await expect.poll(() => tint(last)).not.toBe('rgba(0, 0, 0, 0)')
  const other = rows.nth(1)
  await expect.poll(() => tint(other)).not.toBe(await tint(last))
})

test('pressing outside closes a dropdown', async ({ page }) => {
  await newNote(page)
  await statusPicker(page).click()
  await expect(popover(page)).toBeVisible()
  await page.mouse.move(2, 2)
  await page.mouse.down()
  await page.mouse.up()
  await expect(popover(page)).toHaveCount(0)
})

test('a dialog grows in as the page dims', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      backups_list: { backups: [], lastError: null },
    }
  })
  await openApp(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-backups'))
  })
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await expect(dialog).toBeVisible()
  const names = await dialog.evaluate((el) => ({
    panel: getComputedStyle(el).animationName,
    backdrop: getComputedStyle(el, '::backdrop').animationName,
    dim: getComputedStyle(el, '::backdrop').backgroundColor,
  }))
  expect(names.panel).toBe('dialog-in')
  expect(names.backdrop).toBe('fade-in')
  expect(names.dim).toBe('rgba(0, 0, 0, 0.3)')
})

test('with motion on, a dropdown unfolds as it grows in', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await newNote(page)
  await statusPicker(page).click()
  const list = popover(page)
  await expect(list).toBeVisible()
  expect(await list.evaluate((el) => getComputedStyle(el).animationName)).toMatch(
    /^popover-in, menu-unfold(-up)?$/,
  )
})

test('with motion on, a closing dialog blurs and fades away as the dim fades', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      backups_list: { backups: [], lastError: null },
    }
  })
  await openApp(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-backups'))
  })
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  const copy = page.locator('dialog[data-closing="dialog"]')
  const dim = page.locator('.dialog-backdrop[data-closing]')
  await expect(copy).toHaveCount(1)
  expect(await copy.evaluate((el) => getComputedStyle(el).animationName)).toBe('dialog-out')
  expect(await dim.evaluate((el) => getComputedStyle(el).animationName)).toBe('fade-out')
  await expect(copy).toHaveAttribute('aria-hidden', 'true')
  // Both go once their motion ends.
  await expect(copy).toHaveCount(0)
  await expect(dim).toHaveCount(0)
})
