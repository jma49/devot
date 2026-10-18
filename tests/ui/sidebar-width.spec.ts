import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The sidebar's width: 200 px by default, resized from 170 to 500 px by its
// right edge, kept per window, and giving way to a narrow window only after
// the note list has shrunk to its minimum.

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const list = (page: Page) => page.getByRole('region', { name: 'Notes' })
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize Sidebar' })
const width = async (page: Page) => (await sidebar(page).boundingBox())?.width
const listWidth = async (page: Page) => (await list(page).boundingBox())?.width

/** Drags the sidebar's right edge `by` pixels to the right (left when negative). */
async function dragEdge(page: Page, by: number) {
  const box = await handle(page).boundingBox()
  if (!box) throw new Error('no resize handle')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + by / 2, y)
  await page.mouse.move(x + by, y)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the sidebar is 200 px wide, resizes from 170 to 500 px by its edge and keeps its width', async ({
  page,
}) => {
  await expect(sidebar(page)).toBeVisible()
  expect(await width(page)).toBe(200)

  await dragEdge(page, 80)
  await expect.poll(() => width(page)).toBe(280)
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '280')

  await page.reload()
  await expect.poll(() => width(page)).toBe(280)

  await dragEdge(page, 400)
  await expect.poll(() => width(page)).toBe(500)
  await dragEdge(page, -600)
  await expect.poll(() => width(page)).toBe(170)
})

test('the edge resizes with the keyboard and resets to the default', async ({ page }) => {
  await handle(page).focus()
  await expect(handle(page)).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => width(page)).toBe(210)
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => width(page)).toBe(170)
  await page.keyboard.press('End')
  await expect.poll(() => width(page)).toBe(500)
  await page.keyboard.press('Home')
  await expect.poll(() => width(page)).toBe(170)
  await page.keyboard.press('Enter')
  await expect.poll(() => width(page)).toBe(200)

  await page.keyboard.press('ArrowRight')
  await page.reload()
  await expect.poll(() => width(page)).toBe(210)

  await dragEdge(page, 60)
  await expect.poll(() => width(page)).toBe(270)
  await handle(page).dblclick()
  await expect.poll(() => width(page)).toBe(200)
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '200')
})

test('the sidebar width does not change the note list width', async ({ page }) => {
  const before = await listWidth(page)
  await dragEdge(page, 100)
  await expect.poll(() => width(page)).toBe(300)
  expect(await listWidth(page)).toBe(before)
})

test('a hidden sidebar has no edge to grab', async ({ page }) => {
  await sidebar(page).getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(handle(page)).toBeHidden()
})

test('in a narrow window the note list shrinks first, then the sidebar is clamped', async ({
  page,
}) => {
  await handle(page).focus()
  await page.keyboard.press('End')
  await expect.poll(() => width(page)).toBe(500)

  // 1100 px: the list shrinks to its 220 px minimum, then the sidebar is clamped to 400 px.
  await page.setViewportSize({ width: 1100, height: 800 })
  await expect.poll(() => listWidth(page)).toBe(220)
  await expect.poll(() => width(page)).toBe(400)

  await page.setViewportSize({ width: 1000, height: 800 })
  await expect.poll(() => listWidth(page)).toBe(220)
  await expect.poll(() => width(page)).toBe(300)
})
