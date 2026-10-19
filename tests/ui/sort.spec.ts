import type { Page } from '@playwright/test'
import {
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type TestWindow,
  pickNoteMore,
  openNotePinned,
} from './fixtures'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const noteRows = (page: Page) => list(page).getByRole('option')
// A row's name: its title, or for an untitled note the first line leading its excerpt.
const rowTitles = (page: Page) => list(page).locator('.row-title, .row-headline')
const sections = (page: Page) => list(page).locator('.list-section')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sortButton = (page: Page) => page.getByRole('button', { name: 'Sort Notes' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const filter = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })

const ORDERS = [
  'Title (A to Z)',
  'Title (Z to A)',
  '---',
  'Date Updated (Newest First)',
  'Date Updated (Oldest First)',
  '---',
  'Date Created (Newest First)',
  'Date Created (Oldest First)',
]

/** The order menu as shown, with `checked` ticked and every other order not. */
const menuWith = (
  checked: string,
  followsDefault: boolean | undefined,
  dates: 'Relative' | 'Absolute' = 'Relative',
) => [
  ...ORDERS.map((line) => (line === '---' ? line : `${line} ${line === checked ? '[x]' : '[ ]'}`)),
  ...(followsDefault === undefined
    ? []
    : ['---', `Use as Default ${followsDefault ? '[x]' : '[ ]'}`]),
  '---',
  `Relative Dates ${dates === 'Relative' ? '[x]' : '[ ]'}`,
  `Absolute Dates ${dates === 'Absolute' ? '[x]' : '[ ]'}`,
]

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

/** Clicks the sort button and waits for its menu. */
async function openSortMenu(page: Page) {
  const before = await popups(page)
  await sortButton(page).click()
  await expect.poll(() => popups(page)).toBe(before + 1)
}

async function sortBy(page: Page, label: string) {
  await openSortMenu(page)
  await pickMenuItem(page, label)
  await expect(sortButton(page)).toHaveAttribute('title', `Sorted by ${label}`)
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

async function pinOpenNote(page: Page) {
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
}

const openBook = (page: Page, name: string) =>
  page
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')
    .click()

/** Waits until the in-memory store holds these titles, so a reload keeps them. */
async function saved(page: Page, titles: string[]) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { title: string }[])
          .map((n) => n.title)
          .sort(),
      ),
    )
    .toEqual([...titles].sort())
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the sort pop-up lists the six orders and shows the current one', async ({ page }) => {
  await createNote(page, 'First')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Date Updated (Newest First)')
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Date Updated (Newest First)', true))
  // It opens under the button, not at the pointer.
  const at = await page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.findLast(
        (c) => c.cmd === 'plugin:menu|popup',
      )?.args['at'],
  )
  const box = await sortButton(page).boundingBox()
  expect(at).toEqual({
    position: { type: 'Logical', x: box?.x, y: (box?.y ?? 0) + (box?.height ?? 0) },
  })

  await pickMenuItem(page, 'Title (Z to A)')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Title (Z to A)')
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Title (Z to A)', false))
})

test('an order re-sorts the list, pinned notes in their own section, and survives a reload', async ({
  page,
}) => {
  // Created in this order; then Cherry is edited, so it is the newest updated.
  for (const title of ['banana', 'Cherry', 'apple', 'Date']) await createNote(page, title)
  await pinOpenNote(page) // Date
  await noteRows(page).filter({ hasText: 'apple' }).click()
  await expect(titleField(page)).toHaveValue('apple')
  await pinOpenNote(page)
  await noteRows(page).filter({ hasText: 'Cherry' }).click()
  await expect(titleField(page)).toHaveValue('Cherry')
  await titleField(page).fill('Cherry pie')
  await saved(page, ['banana', 'Cherry pie', 'apple', 'Date'])

  await expect(sections(page)).toHaveText(['Pinned', 'Notes'])
  await sortBy(page, 'Title (A to Z)')
  await expect(rowTitles(page)).toHaveText(['apple', 'Date', 'banana', 'Cherry pie'])
  await sortBy(page, 'Title (Z to A)')
  await expect(rowTitles(page)).toHaveText(['Date', 'apple', 'Cherry pie', 'banana'])
  await sortBy(page, 'Date Created (Oldest First)')
  await expect(rowTitles(page)).toHaveText(['apple', 'Date', 'banana', 'Cherry pie'])
  await sortBy(page, 'Date Created (Newest First)')
  await expect(rowTitles(page)).toHaveText(['Date', 'apple', 'Cherry pie', 'banana'])
  await sortBy(page, 'Date Updated (Oldest First)')
  await expect(rowTitles(page)).toHaveText(['Date', 'apple', 'banana', 'Cherry pie'])
  await sortBy(page, 'Date Updated (Newest First)')
  await expect(rowTitles(page)).toHaveText(['apple', 'Date', 'Cherry pie', 'banana'])

  await sortBy(page, 'Title (Z to A)')
  await page.reload()
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Title (Z to A)')
  await expect(rowTitles(page)).toHaveText(['Date', 'apple', 'Cherry pie', 'banana'])
  await expect(sections(page)).toHaveText(['Pinned', 'Notes'])
  // The arrow keys follow the order on screen.
  await noteRows(page).first().click()
  await page.keyboard.press('ArrowDown')
  await expect(titleField(page)).toHaveValue('apple')
  await page.keyboard.press('ArrowDown')
  await expect(titleField(page)).toHaveValue('Cherry pie')
})

test('each view keeps its own order; Use as Default sets the rest', async ({ page }) => {
  await createNote(page, 'beta')
  await createNote(page, 'Alpha')
  await createNote(page, 'gamma')
  await pinOpenNote(page)
  await createBook(page, 'Work')
  await openBook(page, 'Work')
  await expect(header(page)).toHaveText('Work')
  await createNote(page, 'zulu')
  await createNote(page, 'Yankee')

  // All Notes by title; Work keeps the default order.
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(header(page)).toHaveText('All Notes')
  await sortBy(page, 'Title (A to Z)')
  await expect(rowTitles(page)).toHaveText(['gamma', 'Alpha', 'beta', 'Yankee', 'zulu'])
  await openBook(page, 'Work')
  await expect(header(page)).toHaveText('Work')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Date Updated (Newest First)')
  await expect(rowTitles(page)).toHaveText(['Yankee', 'zulu'])

  // Work: oldest created first, then made the default.
  await sortBy(page, 'Date Created (Oldest First)')
  await expect(rowTitles(page)).toHaveText(['zulu', 'Yankee'])
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Date Created (Oldest First)', false))
  await pickMenuItem(page, 'Use as Default')
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Date Created (Oldest First)', true))

  // A view without its own order follows the default; All Notes keeps its own.
  await filter(page, 'Pinned').click()
  await expect(header(page)).toHaveText('Pinned')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Date Created (Oldest First)')
  await filter(page, 'Pinned').click()
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(header(page)).toHaveText('All Notes')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Title (A to Z)')
  await expect(rowTitles(page)).toHaveText(['gamma', 'Alpha', 'beta', 'Yankee', 'zulu'])

  await page.reload()
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Title (A to Z)')
  await openBook(page, 'Work')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Date Created (Oldest First)')
  await expect(rowTitles(page)).toHaveText(['zulu', 'Yankee'])
})

test('search results keep their relevance order until another order is picked', async ({
  page,
}) => {
  await createNote(page, 'plan b')
  await createNote(page, 'plan a')
  await createNote(page, 'plan c')
  await sortBy(page, 'Title (Z to A)')
  await pickMenuItem(page, 'Use as Default')

  await search(page).fill('plan')
  await expect(header(page)).toHaveText('Search')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Relevance')
  await expect(rowTitles(page)).toHaveText(['plan c', 'plan a', 'plan b'])
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(['Relevance [x]', '---', ...menuWith('', undefined)])

  await pickMenuItem(page, 'Title (A to Z)')
  await expect(sortButton(page)).toHaveAttribute('title', 'Sorted by Title (A to Z)')
  await expect(rowTitles(page)).toHaveText(['plan a', 'plan b', 'plan c'])
  await sortBy(page, 'Relevance')
  await expect(rowTitles(page)).toHaveText(['plan c', 'plan a', 'plan b'])

  // The library keeps its own order.
  await search(page).press('Escape')
  await expect(header(page)).toHaveText('All Notes')
  await expect(rowTitles(page)).toHaveText(['plan c', 'plan b', 'plan a'])
})

test('a new note is scrolled into view when the order puts it at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 420 })
  for (let i = 1; i <= 8; i++) await createNote(page, `Note ${i}`)
  await sortBy(page, 'Date Created (Oldest First)')
  await expect(rowTitles(page).first()).toHaveText('Note 1')
  // The list is longer than its pane and shows its top.
  const overflow = () =>
    list(page).evaluate((el) => ({ top: el.scrollTop, hidden: el.scrollHeight > el.clientHeight }))
  expect(await overflow()).toEqual({ top: 0, hidden: true })
  await expect(noteRows(page).last()).not.toBeInViewport()

  // The editor takes the keyboard; the new row, last in this order, still shows.
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(9)
  const created = noteRows(page).last()
  await expect(created).toHaveAttribute('aria-selected', 'true')
  await expect(titleField(page)).toHaveValue('')
  await expect(created).toBeInViewport()
  await expect(created).not.toBeFocused()
})

test('the Trash has no sort button and keeps its deletion order', async ({ page }) => {
  await createNote(page, 'Gone')
  await pickNoteMore(page, 'Move to Trash')
  await sidebar(page)
    .getByRole('button', { name: /^Trash/ })
    .click()
  await expect(header(page)).toHaveText('Trash')
  await expect(sortButton(page)).toHaveCount(0)
})

test('the sort menu switches the list between relative and absolute dates', async ({ page }) => {
  await page.goto('/')
  await createNote(page, 'Dated')
  const time = noteRows(page).filter({ hasText: 'Dated' }).locator('.row-time')
  await expect(time).toHaveText(/^a few seconds$/)
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Date Updated (Newest First)', true))
  await pickMenuItem(page, 'Absolute Dates')
  // A note changed today shows its time.
  await expect(time).toHaveText(/^\d{1,2}:\d{2}/)
  await openSortMenu(page)
  expect(await shownMenu(page)).toEqual(menuWith('Date Updated (Newest First)', true, 'Absolute'))
  await pickMenuItem(page, 'Relative Dates')
  await expect(time).toHaveText('a few seconds')
})
