import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import { expect, pickMenuItem, reloadApp, test } from './fixtures'

const SEEDED: { title: string; status: string; body: string; pinned?: boolean }[] = [
  {
    title: 'Alpha',
    status: 'active',
    body: '---\nrating: 3\ndone: true\ndue: 2026-02-01\nowner: Ann\n---\nAlpha body.',
  },
  { title: 'Bravo', status: 'none', body: '---\nrating: 10\ndone: false\n---\nBravo body.' },
  { title: 'Charlie', status: 'completed', body: 'No front matter here.' },
  { title: 'Delta', status: 'none', body: '---\nrating: 7\nlabels: [x, y]\n---\n', pinned: true },
]

const id = (i: number) => `0192a6f0-0000-7000-8000-${String(i + 1).padStart(12, '0')}`

function stateOf(body: string): number[] {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, body)
  return Array.from(Y.encodeStateAsUpdate(doc))
}

async function seed(page: Page, given = SEEDED) {
  const seeded = given.map((n) => ({ ...n, ydoc: stateOf(n.body) }))
  await page.goto('/')
  await page.evaluate(
    ({ seeded: list, ids }) => {
      const start = Date.now() - 60_000
      const notes = list.map((n, i) => ({
        id: ids[i],
        title: n.title,
        titleHlc: '',
        bodyMd: n.body,
        ydoc: n.ydoc,
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
    },
    { seeded, ids: seeded.map((_, i) => id(i)) },
  )
  await reloadApp(page)
}

const layout = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Layout' }).getByRole('button', { name, exact: true })
const grid = (page: Page) => page.getByRole('grid')
const headers = (page: Page) => grid(page).getByRole('columnheader')
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader').filter({ hasText: name }).getByRole('button')
const titles = (page: Page) => grid(page).getByRole('rowheader').allTextContents()
const row = (page: Page, title: string) =>
  grid(page)
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: title }) })
const cell = (page: Page, title: string, column: number) =>
  row(page, title).locator(`[aria-colindex="${column}"]`)
const stored = (page: Page, index: number) =>
  page.evaluate((noteId) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      id: string
      bodyMd: string
    }[]
    return notes.find((n) => n.id === noteId)?.bodyMd
  }, id(index))

test.beforeEach(async ({ page }) => {
  await seed(page)
  await layout(page, 'Table').click()
  await expect(grid(page)).toBeVisible()
})

test('a view shows as a table of its notes with a column for each property, typed', async ({
  page,
}) => {
  await expect(layout(page, 'Table')).toHaveAttribute('aria-pressed', 'true')
  await expect(headers(page)).toHaveText([
    'Title',
    'Status',
    'Tags',
    'Date Updated',
    'rating',
    'done',
    'due',
    'labels',
    'owner',
  ])
  await expect(header(page, 'rating')).toHaveAccessibleName('rating, Number')
  expect(await titles(page)).toEqual(['Delta', 'Alpha', 'Bravo', 'Charlie'])
  await expect(cell(page, 'Alpha', 2)).toHaveText('Active')
  await expect(cell(page, 'Alpha', 5)).toHaveText('3')
  await expect(cell(page, 'Alpha', 6).getByRole('checkbox')).toBeChecked()
  await expect(cell(page, 'Bravo', 6).getByRole('checkbox')).not.toBeChecked()
  await expect(cell(page, 'Alpha', 7)).toHaveText('Feb 1, 2026')
  await expect(cell(page, 'Delta', 8).locator('.table-chip')).toHaveText(['x', 'y'])
  await expect(cell(page, 'Charlie', 5)).toHaveText('')

  // The title opens its note beside the table.
  await row(page, 'Bravo').getByRole('rowheader').click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Bravo')
  await expect(row(page, 'Bravo')).toHaveAttribute('aria-selected', 'true')

  // The layout is kept with the view.
  await reloadApp(page)
  await expect(grid(page)).toBeVisible()
})

test('a column header sorts and filters, and the choice is kept', async ({ page }) => {
  await header(page, 'rating').click()
  await pickMenuItem(page, 'Sort Descending')
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie'])
  await expect(grid(page).getByRole('columnheader', { name: /rating/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  )

  await header(page, 'done').click()
  await pickMenuItem(page, 'Show Only Checked')
  await expect.poll(() => titles(page)).toEqual(['Alpha'])
  await expect(page.locator('.list-header')).toContainText('1')

  await reloadApp(page)
  await expect.poll(() => titles(page)).toEqual(['Alpha'])
  await header(page, 'done').click()
  await pickMenuItem(page, 'Show Only Unchecked')
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Delta', 'Charlie'])

  await header(page, 'owner').click()
  await pickMenuItem(page, 'Hide Column')
  await expect(header(page, 'owner')).toHaveCount(0)
  await header(page, 'done').click()
  await pickMenuItem(page, 'Show All Columns')
  await expect(header(page, 'owner')).toHaveCount(1)
})

test('a property cell edits in place and writes the note front matter', async ({ page }) => {
  const rating = cell(page, 'Alpha', 5)
  await rating.dblclick()
  const input = page.getByRole('textbox', { name: 'Edit rating' })
  await expect(input).toHaveValue('3')
  await input.fill('4.5')
  await input.press('Enter')
  await expect(rating).toHaveText('4.5')
  await expect(rating).toBeFocused()
  await expect.poll(() => stored(page, 0)).toContain('rating: 4.5\n')

  // Return opens the editor from the keyboard; Escape leaves the value as it was.
  await rating.press('ArrowRight')
  await expect(cell(page, 'Alpha', 6)).toBeFocused()
  await cell(page, 'Alpha', 6).press('Space')
  await expect(cell(page, 'Alpha', 6).getByRole('checkbox')).not.toBeChecked()
  await expect.poll(() => stored(page, 0)).toContain('done: false\n')
  await cell(page, 'Alpha', 6).press('ArrowRight')
  await cell(page, 'Alpha', 7).press('ArrowRight')
  await cell(page, 'Alpha', 8).press('ArrowRight')
  await cell(page, 'Alpha', 9).press('Enter')
  await page.getByRole('textbox', { name: 'Edit owner' }).fill('Zed')
  await page.getByRole('textbox', { name: 'Edit owner' }).press('Escape')
  await expect(cell(page, 'Alpha', 9)).toHaveText('Ann')
  await expect(cell(page, 'Alpha', 9)).toBeFocused()

  // A note without front matter gets some, the rest of it untouched.
  await cell(page, 'Charlie', 5).dblclick()
  await page.getByRole('textbox', { name: 'Edit rating' }).fill('1')
  await page.getByRole('textbox', { name: 'Edit rating' }).press('Enter')
  await expect.poll(() => stored(page, 2)).toBe('---\nrating: 1\n---\nNo front matter here.')

  // Backspace clears a cell and keeps its key.
  await cell(page, 'Bravo', 5).click()
  await cell(page, 'Bravo', 5).press('Backspace')
  await expect(cell(page, 'Bravo', 5)).toHaveText('')
  await expect.poll(() => stored(page, 1)).toContain('rating:\n')
})

test('a property added from the table is a column to fill', async ({ page }) => {
  await page.getByRole('button', { name: 'Add Property' }).click()
  const name = page.getByRole('textbox', { name: 'Property name' })
  await name.fill('Title')
  await name.press('Enter')
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await name.fill('priority')
  await name.press('Enter')
  await expect(header(page, 'priority')).toHaveCount(1)
  await cell(page, 'Bravo', 10).dblclick()
  await page.getByRole('textbox', { name: 'Edit priority' }).fill('high')
  await page.getByRole('textbox', { name: 'Edit priority' }).press('Enter')
  await expect(cell(page, 'Bravo', 10)).toHaveText('high')
  await expect.poll(() => stored(page, 1)).toContain('priority: high\n')
})

test('front matter that is not valid YAML is left alone, with a message', async ({ page }) => {
  const broken = SEEDED.map((n) =>
    n.title === 'Bravo' ? { ...n, body: '---\nrating: [1,\n---\nBroken.' } : n,
  )
  await seed(page, broken)
  await layout(page, 'Table').click()
  await cell(page, 'Bravo', 5).dblclick()
  await page.getByRole('textbox', { name: 'Edit rating' }).fill('2')
  await page.getByRole('textbox', { name: 'Edit rating' }).press('Enter')
  await expect(page.getByRole('alert')).toHaveText(
    'The note’s front matter is not valid YAML, so it was left unchanged.',
  )
  await expect(cell(page, 'Bravo', 5)).toHaveText('')
  expect(await stored(page, 1)).toBe('---\nrating: [1,\n---\nBroken.')
})
