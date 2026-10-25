import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, reloadApp, test } from './fixtures'

const SEEDED: { title: string; status: string; pinned?: boolean }[] = [
  { title: 'Alpha', status: 'none' },
  { title: 'Bravo', status: 'none' },
  { title: 'Charlie', status: 'active' },
  { title: 'Delta', status: 'active', pinned: true },
  { title: 'Echo', status: 'completed' },
  { title: 'Foxtrot', status: 'dropped' },
]

async function seed(page: Page) {
  await page.goto('/')
  await page.evaluate((seeded) => {
    const start = Date.now() - 60_000
    const notes = seeded.map((n, i) => ({
      id: `0192a6f0-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      title: n.title,
      titleHlc: '',
      bodyMd: '',
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

const layout = (page: Page, name: 'List' | 'Board') =>
  page.getByRole('group', { name: 'Layout' }).getByRole('button', { name, exact: true })
const board = (page: Page) => page.locator('.board')
const column = (page: Page, name: string) =>
  board(page).getByRole('listbox', { name: new RegExp(`^${name}\\b`) })
const card = (page: Page, title: string) =>
  board(page).getByRole('option').filter({ hasText: title })
const cardsIn = (page: Page, name: string) =>
  column(page, name).locator('.card-title').allTextContents()
const listRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sourceRow = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: new RegExp(`^${name} \\d+$`) })

const storedStatus = (page: Page) =>
  page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      title: string
      status: string
    }[]
    return Object.fromEntries(all.map((n) => [n.title, n.status]))
  })

test.beforeEach(async ({ page }) => {
  await seed(page)
})

test('a view switches to a board of five status columns and back, remembered per view', async ({
  page,
}) => {
  await expect(layout(page, 'List')).toHaveAttribute('aria-pressed', 'true')
  await layout(page, 'Board').click()
  await expect(layout(page, 'Board')).toHaveAttribute('aria-pressed', 'true')
  await expect(board(page).locator('.board-column-name')).toHaveText([
    'No Status',
    'Active',
    'On Hold',
    'Completed',
    'Dropped',
  ])
  await expect(board(page).locator('.board-count')).toHaveText(['2', '2', '0', '1', '1'])
  // On Hold is empty and still shows.
  await expect(column(page, 'On Hold')).toBeVisible()
  expect(await cardsIn(page, 'Active')).toEqual(['Delta', 'Charlie'])

  // Pinned is another view: a list until it is switched.
  await sourceRow(page, 'Pinned').click()
  await expect(listRows(page)).toHaveCount(1)
  await expect(board(page)).toHaveCount(0)
  await page.getByRole('button', { name: /^All Notes \d+$/ }).click()
  await expect(board(page)).toBeVisible()

  await reloadApp(page)
  await expect(board(page)).toBeVisible()
  await layout(page, 'List').click()
  await expect(board(page)).toHaveCount(0)
  await expect(listRows(page)).toHaveCount(6)
  await reloadApp(page)
  await expect(listRows(page)).toHaveCount(6)
})

test('a card opens its note, and a drop on another column sets its status, one undo step', async ({
  page,
}) => {
  await layout(page, 'Board').click()
  await card(page, 'Alpha').click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha')

  await card(page, 'Alpha').dragTo(column(page, 'On Hold'))
  await expect.poll(async () => (await storedStatus(page))['Alpha']).toBe('on_hold')
  expect(await cardsIn(page, 'On Hold')).toEqual(['Alpha'])

  await card(page, 'Alpha').focus()
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await storedStatus(page))['Alpha']).toBe('none')
  expect(await cardsIn(page, 'No Status')).toEqual(['Alpha', 'Bravo'])
  await page.keyboard.press('Meta+Shift+z')
  await expect.poll(async () => (await storedStatus(page))['Alpha']).toBe('on_hold')
})

test('selected cards move together, and one undo takes them all back', async ({ page }) => {
  await layout(page, 'Board').click()
  await card(page, 'Alpha').click()
  await card(page, 'Charlie').click({ modifiers: ['Meta'] })
  await expect(board(page).locator('.card[aria-selected="true"]')).toHaveCount(2)
  // A column in sight: Playwright scrolling one into view mid-drag moves the card from under the pointer.
  await card(page, 'Charlie').dragTo(column(page, 'On Hold'))
  await expect
    .poll(async () => {
      const s = await storedStatus(page)
      return [s['Alpha'], s['Charlie']]
    })
    .toEqual(['on_hold', 'on_hold'])
  expect((await cardsIn(page, 'On Hold')).sort()).toEqual(['Alpha', 'Charlie'])

  await card(page, 'Charlie').focus()
  await page.keyboard.press('Meta+z')
  await expect
    .poll(async () => {
      const s = await storedStatus(page)
      return [s['Alpha'], s['Charlie']]
    })
    .toEqual(['none', 'active'])
})

test('arrow keys move between cards and columns; Control+Command+arrows move cards', async ({
  page,
}) => {
  await layout(page, 'Board').click()
  await card(page, 'Alpha').click()
  await page.keyboard.press('ArrowDown')
  await expect(card(page, 'Bravo')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'Charlie')).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Charlie')
  // On Hold is empty: Completed is next.
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'Echo')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowUp')
  await expect(card(page, 'Delta')).toBeFocused()

  await page.keyboard.press('Meta+Control+ArrowRight')
  await expect.poll(async () => (await storedStatus(page))['Delta']).toBe('on_hold')
  expect(await cardsIn(page, 'On Hold')).toEqual(['Delta'])
  await expect(card(page, 'Delta')).toBeFocused()
  await page.keyboard.press('Meta+Control+ArrowLeft')
  await page.keyboard.press('Meta+Control+ArrowLeft')
  await expect.poll(async () => (await storedStatus(page))['Delta']).toBe('none')
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await storedStatus(page))['Delta']).toBe('active')
})

test('a setting hides the Dropped column', async ({ page }) => {
  await layout(page, 'Board').click()
  await expect(column(page, 'Dropped')).toBeVisible()
  await changeEditorSettingsElsewhere(page, { boardDropped: false })
  await expect(column(page, 'Dropped')).toHaveCount(0)
  await expect(card(page, 'Foxtrot')).toHaveCount(0)
  await expect(board(page).locator('.board-column')).toHaveCount(4)
})

test('in a narrow window the columns keep their width and scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 })
  await layout(page, 'Board').click()
  const scroller = board(page).locator('.board-columns')
  const sizes = await scroller.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    columns: [...el.querySelectorAll('.board-column')].map((c) => c.getBoundingClientRect().width),
  }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  for (const width of sizes.columns) expect(width).toBeGreaterThanOrEqual(184)
  // The keyboard brings a column out of sight into view.
  await card(page, 'Echo').click()
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'Foxtrot')).toBeFocused()
  await expect(card(page, 'Foxtrot')).toBeInViewport()
})
