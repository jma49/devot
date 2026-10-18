import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The note list as a pane: its width, its empty states, the card a drag
// shows and how far its titles run.

const pane = (page: Page) => page.getByRole('region', { name: 'Notes' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const handle = (page: Page) => page.getByRole('separator', { name: 'Resize Note List' })
const width = async (page: Page) => (await pane(page).boundingBox())?.width

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

/** Drags the list's right edge `by` pixels to the right (left when negative). */
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

test('the list is 300 px wide, resizes from 220 to 500 px by its edge and keeps its width', async ({
  page,
}) => {
  await expect(pane(page)).toBeVisible()
  expect(await width(page)).toBe(300)

  await dragEdge(page, 80)
  await expect.poll(() => width(page)).toBe(380)
  await expect(handle(page)).toHaveAttribute('aria-valuenow', '380')

  await page.reload()
  await expect.poll(() => width(page)).toBe(380)

  await dragEdge(page, 400)
  await expect.poll(() => width(page)).toBe(500)
  await dragEdge(page, -600)
  await expect.poll(() => width(page)).toBe(220)
})

test('an empty list says why', async ({ page }) => {
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Trash/ })
    .click()
  await expect(pane(page)).toContainText('Trash Is Empty')

  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await createNote(page, 'Garden plan')
  await expect(pane(page).locator('.list-empty')).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('zzqxv')
  await expect(pane(page)).toContainText('No Matching Notes')
  await expect(pane(page)).toContainText('Try other words, or search all notes.')
})

test('the list announces its note count in a status region', async ({ page }) => {
  await createNote(page, 'Garden plan')
  await expect(pane(page).getByRole('status')).toHaveText('1 note')
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('zzqxv')
  await expect(pane(page).getByRole('status')).toContainText('0 notes')
})

test('a long title runs to two lines, then is cut off', async ({ page }) => {
  await createNote(page, 'Short')
  await createNote(
    page,
    'A rather long title that keeps going well past the width of the list pane',
  )
  const short = noteRow(page, 'Short').locator('.row-title')
  const long = noteRow(page, 'A rather long').locator('.row-title')
  const lineHeight = (await short.boundingBox())?.height ?? 0
  await expect.poll(async () => (await long.boundingBox())?.height).toBeCloseTo(lineHeight * 2, 0)
  await expect(long).toHaveCSS('-webkit-line-clamp', '2')
  // The title starts 15 px in from the row's left edge.
  const rowBox = await noteRow(page, 'Short').boundingBox()
  const titleBox = await short.boundingBox()
  expect(Math.round((titleBox?.x ?? 0) - (rowBox?.x ?? 0))).toBe(15)
})

test('dragging several notes shows a card with their titles, and the count past four', async ({
  page,
}) => {
  await page.evaluate(() => {
    const seen: string[][] = []
    ;(globalThis as unknown as { dragCards: string[][] }).dragCards = seen
    const original = DataTransfer.prototype.setDragImage
    DataTransfer.prototype.setDragImage = function (image: Element, x: number, y: number) {
      seen.push([...image.querySelectorAll('.drag-card-line')].map((l) => l.textContent ?? ''))
      original.call(this, image, x, y)
    }
  })
  const cards = () =>
    page.evaluate(() => (globalThis as unknown as { dragCards: string[][] }).dragCards)
  for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) await createNote(page, title)
  // Somewhere that takes no drop: only the drag's start matters here.
  const away = pane(page).locator('.toolbar-title')

  await noteRow(page, 'Two').click()
  await noteRow(page, 'One').click({ modifiers: ['Meta'] })
  await noteRow(page, 'One').dragTo(away)
  await expect.poll(async () => (await cards())[0]?.toSorted()).toEqual(['One', 'Two'])

  await noteRow(page, 'Five').click()
  await page.keyboard.press('Meta+A')
  await noteRow(page, 'Three').dragTo(away)
  await expect.poll(async () => (await cards())[1]).toEqual(['5 notes'])
})
