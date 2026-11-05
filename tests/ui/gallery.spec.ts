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
const cardTitles = (page: Page) => gallery(page).locator('.gallery-card-title').allTextContents()
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })

test.beforeEach(async ({ page }) => {
  await seed(page)
})

test('a view switches to a gallery of page previews, and a card opens its note', async ({
  page,
}) => {
  await layout(page, 'Gallery').click()
  await expect(layout(page, 'Gallery')).toHaveAttribute('aria-pressed', 'true')
  await expect(gallery(page).getByRole('option')).toHaveCount(5)
  // The view's order, pinned first.
  expect(await cardTitles(page)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie', 'Echo'])

  const alpha = card(page, 'Alpha')
  await expect(alpha.locator('.gallery-page h1')).toHaveText('Plan')
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
  await expect(titleField(page)).toHaveValue('Echo')

  // Remembered per view.
  await reloadApp(page)
  await expect(gallery(page)).toBeVisible()
  await layout(page, 'List').click()
  await expect(gallery(page)).toHaveCount(0)
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(5)
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
  expect(await cardTitles(page)).toEqual(['Alpha', 'Charlie'])

  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.fill('math')
  await expect.poll(() => cardTitles(page)).toEqual(['Charlie'])
  await search.fill('')
  await expect.poll(() => cardTitles(page)).toEqual(['Alpha', 'Charlie'])
})
