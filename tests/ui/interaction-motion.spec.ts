import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const newNote = (page: Page) => page.getByRole('button', { name: 'New Note', exact: true })

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test('a pressed button shrinks and springs back', async ({ page }) => {
  await openApp(page)
  const button = newNote(page)
  const box = await button.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).scale)).toBe('0.96')
  await page.mouse.move(0, 0)
  await page.mouse.up()
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).scale)).toBe('none')
})

test('reduced motion leaves a pressed button its size', async ({ page }) => {
  await openApp(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const button = newNote(page)
  const box = await button.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(150)
  expect(await button.evaluate((el) => getComputedStyle(el).scale)).toBe('1')
  await page.mouse.move(0, 0)
  await page.mouse.up()
})

test('a segment thumb slides to the new mode, on top of the final state, and is removed', async ({
  page,
}) => {
  await openApp(page)
  await newNote(page).click()
  const group = page.getByRole('group', { name: 'View mode' })
  const pressed = group.getByRole('button', { pressed: true })
  await page.evaluate(() => {
    const w = globalThis as unknown as { devotThumb?: string }
    new MutationObserver((_, observer) => {
      const thumb = document.querySelector('.segment-thumb')
      if (!thumb) return
      observer.disconnect()
      w.devotThumb = (thumb as HTMLElement).style.transform
    }).observe(document.body, { childList: true, subtree: true })
  })
  await group.getByRole('button', { name: 'Preview' }).click()
  await expect(pressed).toHaveAccessibleName('Preview')
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as unknown as { devotThumb?: string }).devotThumb ?? ''),
    )
    .toMatch(/translateX\(/)
  await expect(page.locator('.segment-thumb')).toHaveCount(0)
  await expect(group).not.toHaveAttribute('data-sliding')
})

test('dragging the thumb to another segment selects it', async ({ page }) => {
  await openApp(page)
  await newNote(page).click()
  const group = page.getByRole('group', { name: 'View mode' })
  const from = await group.getByRole('button', { pressed: true }).boundingBox()
  const to = await group.getByRole('button', { name: 'Preview' }).boundingBox()
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
  await page.mouse.down()
  await expect(page.locator('.segment-thumb')).toHaveCount(1)
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(group.getByRole('button', { pressed: true })).toHaveAccessibleName('Preview')
  await expect(page.locator('.segment-thumb')).toHaveCount(0)
})

test('the pane that comes with a mode change slides in', async ({ page }) => {
  await openApp(page)
  await newNote(page).click()
  await page.evaluate(() => {
    const w = globalThis as unknown as { devotFades?: number }
    new MutationObserver((_, observer) => {
      const pane = document.querySelector('.panes > .preview')
      if (!pane) return
      observer.disconnect()
      queueMicrotask(() => {
        w.devotFades = pane.getAnimations().length
      })
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as unknown as { devotFades?: number }).devotFades ?? -1),
    )
    .toBeGreaterThan(0)
})
