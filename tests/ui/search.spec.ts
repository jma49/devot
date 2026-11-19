import type { Page } from '@playwright/test'
import { expect, test, pickBook, pickNoteMore, pickStatus, openApp } from './fixtures'

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
  await openApp(page)
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

  await search(page).press('Escape')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(3)
})

test('the search field never autocorrects queries', async ({ page }) => {
  await expect(search(page)).toHaveAttribute('autocorrect', 'off')
  await expect(search(page)).toHaveAttribute('autocapitalize', 'off')
  await expect(search(page)).toHaveAttribute('spellcheck', 'false')
})

test('Return shows the correct result without waiting for the short-query debounce', async ({
  page,
}) => {
  await createNote(page, 'Zebra')
  await createNote(page, 'Zenith')
  const field = search(page)
  await page.clock.install()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  await field.fill('eb')
  await expect(header(page)).toHaveText('All Notes')
  await field.press('Enter')
  await page.clock.runFor(32)
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveText([/^Zebra/])
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

test('inline filter pills and syntax autocomplete stay bidirectionally synced', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const bookField = page.getByRole('textbox', { name: 'Notebook name' })
  await bookField.fill('Weekly notes')
  await bookField.press('Enter')
  await page.getByRole('button', { name: /^All Notes/ }).click()

  await createNote(page, 'Sprint alpha', 'Launch roadmap inside Weekly notes')
  await pickStatus(page, 'Active')
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('urgent')
  await tagField.press('Enter')
  await pickBook(page, 'Weekly notes')

  await createNote(page, 'Backlog beta', 'Another roadmap note')
  await pickStatus(page, 'On Hold')

  const box = search(page)
  const suggestions = page.getByRole('listbox', { name: 'Search suggestions' })
  const pills = page.locator('.search-pill')

  await box.click()
  await box.fill('in:we')
  await expect(suggestions).toBeVisible()
  await expect(suggestions.getByRole('option')).toContainText(['in:Weekly notes'])

  // First Escape closes autocomplete without clearing typed query.
  await box.press('Escape')
  await expect(suggestions).toBeHidden()
  await expect(box).toHaveValue('in:we')

  await box.fill('in:week')
  await expect(suggestions).toBeVisible()
  await box.press('Tab')
  await expect(pills).toHaveCount(1)
  await expect(pills.nth(0)).toContainText('in:')
  await expect(pills.nth(0)).toContainText('Weekly notes')
  await expect(box).toHaveValue('')

  await box.fill('#u')
  await expect(suggestions.getByRole('option')).toContainText(['#urgent'])
  await box.press('Enter')
  await expect(pills).toHaveCount(2)

  await box.fill('is:act')
  await expect(suggestions.getByRole('option')).toContainText(['is:active'])
  await box.press('Enter')
  await expect(pills).toHaveCount(3)

  await box.fill('-pinned:t')
  await expect(suggestions.getByRole('option')).toContainText(['-pinned:true'])
  await box.press('Enter')
  await expect(pills).toHaveCount(4)

  await expect(noteRows(page)).toHaveText([/^Sprint alpha/])

  // Removing a middle pill leaves the rest intact; Backspace at caret 0 unwraps the last pill.
  await pills
    .nth(1)
    .getByRole('button', { name: /Remove filter #urgent/ })
    .click()
  await expect(pills).toHaveCount(3)
  await box.focus()
  await box.press('Backspace')
  await expect(pills).toHaveCount(2)
  await expect(box).toHaveValue('-pinned:true')
})
