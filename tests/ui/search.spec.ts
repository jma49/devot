import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const header = (page: Page) => page.locator('.list .headline')

// "\u540c\u6b65\u65b9\u6848" is a Chinese title ("sync plan"); "\u540c\u6b65" its first word.
const SYNC_PLAN = '\u540c\u6b65\u65b9\u6848'

async function createNote(page: Page, title: string, body = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(body)
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('finds notes by title and body, in English and Chinese', async ({ page }) => {
  await createNote(page, 'Relay design', 'WebSocket hibernation')
  await createNote(page, SYNC_PLAN, 'Yjs notes')
  await createNote(page, 'Groceries', 'apples')

  await search(page).fill('hibernat')
  await expect(header(page)).toHaveText('Search Results')
  await expect(noteRows(page)).toHaveText([/^Relay design/])

  await search(page).fill('\u540c\u6b65')
  await expect(noteRows(page)).toHaveText([new RegExp(`^${SYNC_PLAN}`)])

  // Escape clears the search and shows the library again.
  await search(page).press('Escape')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(3)
})

test('the search field never autocorrects queries', async ({ page }) => {
  await expect(search(page)).toHaveAttribute('autocorrect', 'off')
  await expect(search(page)).toHaveAttribute('autocapitalize', 'off')
  await expect(search(page)).toHaveAttribute('spellcheck', 'false')
})

test('results follow edits and the trash', async ({ page }) => {
  await createNote(page, 'Draft', 'first words')
  await search(page).fill('first')
  // The library list also has one row: wait for the results to replace it.
  await expect(header(page)).toHaveText('Search Results')
  await expect(noteRows(page)).toHaveCount(1)
  await noteRows(page).first().click()
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page)).toHaveCount(0)
})

test('Shift+Opt+Cmd+F focuses the search field; picking a library clears it', async ({ page }) => {
  await createNote(page, 'Alpha')
  await page.keyboard.press('Shift+Alt+Meta+KeyF')
  await expect(search(page)).toBeFocused()
  await page.keyboard.type('nothing matches this')
  await expect(noteRows(page)).toHaveCount(0)
  await page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(search(page)).toHaveValue('')
  await expect(noteRows(page)).toHaveCount(1)
})
