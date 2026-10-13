import type { Page } from '@playwright/test'
import { expect, test, pickNoteMore, pickStatus } from './fixtures'
import { seedNotes } from './renders'

// The note list shows the user's own changes at once: new dates and order
// after typing, new titles in search results, and every note just made.

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const rows = (page: Page) => list(page).getByRole('option')
// A row's name: its title, or for an untitled note the first line leading its excerpt.
const rowTitles = (page: Page) => list(page).locator('.row-title, .row-headline')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const filter = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const selectedRow = (page: Page) => rows(page).and(page.locator('[aria-selected="true"]'))
const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.locator('.row-title', { hasText: new RegExp(`^${title}$`) }) })

async function openNote(page: Page, title: string) {
  await row(page, title).click()
  await expect(titleField(page)).toHaveValue(title)
}

const newNote = (page: Page) => page.getByRole('button', { name: 'New Note', exact: true }).click()

/** The view shows All Notes with a new, empty note open and listed. */
async function expectNewNoteListed(page: Page, total: number) {
  await expect(header(page)).toHaveText('All Notes')
  await expect(rows(page)).toHaveCount(total)
  await expect(titleField(page)).toHaveValue('')
  await expect(selectedRow(page)).toHaveCount(1)
  await expect(selectedRow(page).locator('.row-headline')).toHaveText('Untitled')
  await expect(selectedRow(page).locator('.row-title')).toHaveCount(0)
}

test('an edited note moves to the top with its new date', async ({ page }) => {
  await seedNotes(page, 3)
  await expect(rowTitles(page)).toHaveText(['Note 1', 'Note 2', 'Note 3'])
  const started = await page.evaluate(() => Date.now())
  await openNote(page, 'Note 3')
  await body(page).click()
  await page.keyboard.type('Fresh words')

  // The list follows the save; no other change reloads it.
  await expect(rowTitles(page)).toHaveText(['Note 3', 'Note 1', 'Note 2'])
  const shown = await row(page, 'Note 3').locator('time').getAttribute('datetime')
  expect(Date.parse(shown ?? '')).toBeGreaterThanOrEqual(started - 1000)
})

test('a note renamed during a search shows its new title in the results', async ({ page }) => {
  await seedNotes(page, 3)
  await search(page).fill('Note 2')
  await expect(header(page)).toHaveText('Search Results')
  await expect(rowTitles(page)).toHaveText(['Note 2'])
  await openNote(page, 'Note 2')

  await titleField(page).fill('Renamed plan')
  await expect(rowTitles(page)).toHaveText(['Renamed plan'])
})

test('New Note in Pinned lists the new note in All Notes', async ({ page }) => {
  await seedNotes(page, 3)
  await openNote(page, 'Note 1')
  await pickNoteMore(page, 'Pin to Top')
  await expect(filter(page, 'Pinned')).toHaveText(/1$/)
  await filter(page, 'Pinned').click()
  await expect(rows(page)).toHaveCount(1)

  await newNote(page)
  await expectNewNoteListed(page, 4)
  await expect(filter(page, 'Pinned')).toHaveAttribute('aria-pressed', 'false')
})

test('New Note in a status or tag view lists the new note in All Notes', async ({ page }) => {
  await seedNotes(page, 3)
  await openNote(page, 'Note 2')
  await pickStatus(page, 'Active')
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('plans')
  await tagField.press('Enter')
  await expect(sidebar(page).getByRole('button', { name: /^plans 1$/ })).toBeVisible()

  await filter(page, 'Active').click()
  await expect(rows(page)).toHaveCount(1)
  await newNote(page)
  await expectNewNoteListed(page, 4)

  await sidebar(page)
    .getByRole('button', { name: /^plans 1$/ })
    .click()
  await expect(rows(page)).toHaveCount(1)
  await newNote(page)
  await expectNewNoteListed(page, 5)
})

test('New Note during a search leaves the search and lists the new note', async ({ page }) => {
  await seedNotes(page, 3)
  await search(page).fill('Note')
  await expect(header(page)).toHaveText('Search Results')
  await expect(rows(page)).toHaveCount(3)

  await newNote(page)
  await expectNewNoteListed(page, 4)
  await expect(search(page)).toHaveValue('')
})
