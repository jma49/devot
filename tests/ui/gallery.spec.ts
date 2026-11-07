import type { Page } from '@playwright/test'
import { expect, reloadApp, test } from './fixtures'

const SEEDED: { title: string; status: string; body: string; pinned?: boolean }[] = [
  {
    title: 'Alpha',
    status: 'active',
    body: '# Plan\n\nSome **bold** text.\n\n- [x] done\n- [ ] open\n\n| a | b |\n| - | - |\n| 1 | 2 |',
  },
  { title: 'Bravo', status: 'none', body: '```mermaid\ngraph TD; A-->B\n```\n\nAfter the chart.' },
  { title: 'Charlie', status: 'active', body: 'Inline $x^2$ math.' },
  { title: 'Delta', status: 'completed', body: 'Pinned body.', pinned: true },
  { title: 'Echo', status: 'none', body: '' },
  { title: '', status: 'none', body: 'Foxtrot opens the page.\n\nMore below.' },
]

async function seed(page: Page) {
  await page.goto('/')
  await page.evaluate((seeded) => {
    const start = Date.now() - 60_000
    const notes = seeded.map((n, i) => ({
      id: `0192a6f0-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      title: n.title,
      titleHlc: '',
      bodyMd: n.body,
      ydoc: [0, 0],
      bookId: null,
      bookHlc: '',
      status: n.status,
      statusHlc: '',
      pinned: n.pinned ?? false,
      pinnedHlc: '',
      createdAt: start - i * 60_000,
      updatedAt: start - i * 60_000,
      deletedAt: null,
      deletedHlc: null,
    }))
    localStorage.clear()
    localStorage.setItem('devot.test.notes', JSON.stringify(notes))
  }, SEEDED)
  await reloadApp(page)
}

const layoutGroup = (page: Page) => page.getByRole('group', { name: 'Layout' })
const layout = (page: Page, name: 'List' | 'Board' | 'Gallery') =>
  layoutGroup(page).getByRole('button', { name, exact: true })
const gallery = (page: Page) => page.locator('.gallery')
const card = (page: Page, title: string) =>
  gallery(page).getByRole('option').filter({ hasText: title })
const cardTitles = (page: Page) => gallery(page).locator('.note-title').allTextContents()
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })

test.beforeEach(async ({ page }) => {
  await seed(page)
})

test('a view switches to a gallery of page previews, and a card opens its note', async ({
  page,
}) => {
  await layout(page, 'Gallery').click()
  await expect(layout(page, 'Gallery')).toHaveAttribute('aria-pressed', 'true')
  await expect(gallery(page).getByRole('option')).toHaveCount(6)
  // The view's order, pinned first; the untitled note's page starts with its first line.
  expect(await cardTitles(page)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie', 'Echo'])
  const foxtrot = card(page, 'Foxtrot')
  // Named by its content, as a board card is: the title, then the caption.
  await expect(foxtrot).toHaveAccessibleName(/^Foxtrot opens the page\. \S/)
  await expect(foxtrot.locator('.note-title')).toHaveCount(0)
  await expect(foxtrot.locator('.gallery-page p').first()).toHaveText('Foxtrot opens the page.')

  const alpha = card(page, 'Alpha')
  await expect(alpha.locator('.gallery-page h1:not(.note-title)')).toHaveText('Plan')
  await expect(alpha.locator('.gallery-page input[type=checkbox]')).toHaveCount(2)
  await expect(alpha.locator('.gallery-page table')).toHaveCount(1)
  // Diagrams and math never run in a card.
  await expect(card(page, 'Bravo').locator('.card-placeholder')).toHaveText('Diagram')
  await expect(card(page, 'Bravo').locator('.island, svg')).toHaveCount(0)
  await expect(card(page, 'Charlie').locator('.card-placeholder')).toHaveText('Math')

  await alpha.click()
  await expect(titleField(page)).toHaveValue('Alpha')
  await expect(alpha).toHaveAttribute('aria-selected', 'true')

  // Arrows move across the grid.
  await alpha.focus()
  await page.keyboard.press('ArrowRight')
  await expect(titleField(page)).toHaveValue('Bravo')
  await expect(card(page, 'Bravo')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(titleField(page)).toHaveValue('Alpha')
  await page.keyboard.press('End')
  await expect(titleField(page)).toHaveValue('')
  await expect(foxtrot).toBeFocused()

  // Remembered per view.
  await reloadApp(page)
  await expect(gallery(page)).toBeVisible()
  await layout(page, 'List').click()
  await expect(gallery(page)).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(6)
})

test("a card is the note's first page on a sheet, with the pin, the status and the time under it, selected as a row is", async ({
  page,
}) => {
  await layout(page, 'Gallery').click()
  const cards = gallery(page).getByRole('option')
  await expect(cards).toHaveCount(6)
  for (const c of await cards.all()) {
    await expect(c.locator('.gallery-sheet .gallery-page').first()).toBeVisible()
    await expect(c.locator('.gallery-card-caption time')).toHaveCount(1)
  }
  await expect(card(page, 'Delta').locator('.gallery-card-caption .card-pin')).toHaveCount(1)
  await expect(card(page, 'Alpha').locator('.gallery-card-caption .card-pin')).toHaveCount(0)
  await expect(card(page, 'Delta').locator('.card-status.status-completed')).toHaveCount(1)
  await expect(card(page, 'Alpha').locator('.card-status.status-active')).toHaveCount(1)
  await expect(card(page, 'Echo').locator('.card-status')).toHaveCount(0)

  const titles = gallery(page).locator('.gallery-sheet .note-title')
  await expect(titles).toHaveCount(5)
  const weights = await titles.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).fontWeight),
  )
  expect(new Set(weights).size).toBe(1)
  expect(Number(weights[0])).toBeGreaterThanOrEqual(700)

  const alpha = card(page, 'Alpha')
  await alpha.click()
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
  await alpha.focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await expect(alpha).toBeFocused()
  const look = await alpha.evaluate((el) => {
    const style = getComputedStyle(el)
    return { shadow: style.boxShadow, background: style.backgroundColor }
  })
  // The list's selection wash, and no bar down the side.
  expect(look.shadow).toBe('none')
  expect(look.background).not.toBe('rgba(0, 0, 0, 0)')
  const rest = await card(page, 'Charlie').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(rest).toBe('rgba(0, 0, 0, 0)')
})

test('a status view and a search in the view show as a gallery too, never as a board', async ({
  page,
}) => {
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Active \d+$/ })
    .click()
  await expect(layout(page, 'Board')).toHaveCount(0)
  await layout(page, 'Gallery').click()
  await expect.poll(() => cardTitles(page)).toEqual(['Alpha', 'Charlie'])

  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.fill('math')
  await expect.poll(() => cardTitles(page)).toEqual(['Charlie'])
  await search.fill('')
  await expect.poll(() => cardTitles(page)).toEqual(['Alpha', 'Charlie'])
})

test('an untitled note with an empty body shows Untitled on its page', async ({ page }) => {
  await layout(page, 'Gallery').click()
  const echo = card(page, 'Echo')
  await echo.click()
  await titleField(page).fill('')
  const empty = gallery(page).locator('.gallery-page .note-title.is-untitled')
  await expect(empty).toHaveText('Untitled')
})

test('cards are 220 to 300 wide, each sheet 3:4, and the pane opens at the board’s fitted width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await layout(page, 'Gallery').click()
  await expect(gallery(page).getByRole('option')).toHaveCount(6)
  expect((await gallery(page).boundingBox())?.width).toBe(964)
  const boxes = await gallery(page)
    .locator('.gallery-card')
    .evaluateAll((els) =>
      els.map((el) => {
        const sheet = el.querySelector('.gallery-sheet')!.getBoundingClientRect()
        return { card: el.getBoundingClientRect().width, ratio: sheet.height / sheet.width }
      }),
    )
  for (const box of boxes) {
    expect(box.card).toBeGreaterThanOrEqual(220)
    expect(box.card).toBeLessThanOrEqual(300)
    expect(box.ratio).toBeCloseTo(4 / 3, 2)
  }
})

test('a caption shows the task progress of a note with tasks, and none without', async ({
  page,
}) => {
  await layout(page, 'Gallery').click()
  const alpha = card(page, 'Alpha').locator('.gallery-card-caption .card-tasks')
  await expect(alpha).toHaveText('1/2')
  await expect(card(page, 'Alpha')).toHaveAccessibleName(/Alpha.*1 of 2 tasks done/)
  await expect(card(page, 'Charlie')).toBeVisible()
  await expect(card(page, 'Charlie').locator('.card-tasks')).toHaveCount(0)
})
