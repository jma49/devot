import type { Page } from '@playwright/test'
import { expect, test, pickNoteMore } from './fixtures'

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
  await expect(header(page)).toHaveText('Search')
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
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(1)
  await noteRows(page).first().click()
  await pickNoteMore(page, 'Move to Trash')
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

test('after clearing a search, the next query does not show the previous results', async ({
  page,
}) => {
  await createNote(page, 'Foo plan')
  await createNote(page, 'Bar plan')
  await search(page).fill('foo')
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveText([/^Foo plan/])
  await search(page).fill('')
  await expect(header(page)).toHaveText('All Notes')

  // Hold the debounce so the new query's answer cannot arrive.
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await search(page).pressSequentially('b')
  await expect(search(page)).toHaveValue('b')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
  await page.clock.resume()
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveText([/^Bar plan/])
})

test('pinned: narrows the list, and a malformed value is searched as text', async ({ page }) => {
  await createNote(page, 'Pinned plan')
  await pickNoteMore(page, 'Pin to Top')
  await createNote(page, 'Loose plan')

  await search(page).fill('plan pinned:true')
  await expect(noteRows(page)).toHaveText([/^Pinned plan/])
  await search(page).fill('plan pinned:false')
  await expect(noteRows(page)).toHaveText([/^Loose plan/])
  await search(page).fill('plan -pinned:false')
  await expect(noteRows(page)).toHaveText([/^Pinned plan/])
  // Not a pinned value: the text "pinned:maybe" is searched for.
  await search(page).fill('plan pinned:maybe')
  await expect(noteRows(page)).toHaveCount(0)
})

test('the syntax help opens from its button, and Escape closes it before clearing the search', async ({
  page,
}) => {
  const help = page.getByRole('dialog', { name: 'Search Syntax' })
  const button = page.getByRole('button', { name: 'Search Syntax' })
  await search(page).fill('plan')
  await button.click()
  await expect(help).toBeVisible()
  await expect(help).toContainText('-status:')
  await expect(help).toContainText('bookId:ID')

  // The first Escape closes the help and keeps the query; the next clears it.
  await search(page).focus()
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
  await expect(search(page)).toHaveValue('plan')
  await page.keyboard.press('Escape')
  await expect(search(page)).toHaveValue('')

  await button.click()
  await expect(help).toBeVisible()
  await button.press('Escape')
  await expect(help).toBeHidden()
  await expect(button).toBeFocused()
  await button.click()
  await header(page).click()
  await expect(help).toBeHidden()
})
