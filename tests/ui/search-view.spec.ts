import type { Page } from '@playwright/test'
import { expect, test, pickStatus } from './fixtures'

// Search syntax, the two search shortcuts (this view or every note), and
// highlighted matches in the list.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const header = (page: Page) => page.locator('.list .headline')
const caption = (page: Page) => page.locator('.list .list-count')
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', {
    name: new RegExp(`^${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}(?:\\s|$)`),
  })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

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

async function showAllNotes(page: Page) {
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(header(page)).toHaveText('All Notes')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Shift+Cmd+F searches the current view; Shift+Opt+Cmd+F searches every note', async ({
  page,
}) => {
  await createNote(page, 'Loose plan')
  await createBook(page, 'Work')
  await createNote(page, 'Work plan')
  await expect(header(page)).toHaveText('Work')

  // The list has the keyboard, then the shortcut moves it to the field.
  await noteRows(page).first().click()
  await page.keyboard.press('Meta+Shift+KeyF')
  await expect(search(page)).toBeFocused()
  await expect(search(page)).toHaveAttribute('placeholder', 'Filter')
  await page.keyboard.type('plan')
  await expect(header(page)).toHaveText('Search')
  await expect(caption(page)).toHaveText('In Work · 1 note')
  await expect(noteRows(page)).toHaveText([/^Work plan/])
  // The notebook stays selected while its notes are searched.
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')

  // The same words, now over every note.
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await expect(search(page)).toBeFocused()
  await expect(search(page)).toHaveValue('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(noteRows(page)).toHaveCount(2)

  // / in the results moves to the field without changing where it looks:
  // a new query there still searches every note, so it finds the loose
  // note, which is outside Work.
  await noteRows(page).first().click()
  await page.keyboard.press('/')
  await expect(search(page)).toBeFocused()
  await page.keyboard.type('loose')
  await expect(search(page)).toHaveValue('loose')
  await expect(noteRows(page)).toHaveText([/^Loose plan/])
  await expect(caption(page)).toHaveText('1 note')
  await expect(search(page)).toHaveAttribute('placeholder', 'Search')

  // Escape clears the field: the notebook's own list comes back.
  await search(page).press('Escape')
  await expect(search(page)).toHaveValue('')
  await expect(header(page)).toHaveText('Work')
  await expect(search(page)).toHaveAttribute('placeholder', 'Filter')
})

test('searching a filter narrows within it', async ({ page }) => {
  await createNote(page, 'Active plan')
  await pickStatus(page, 'Active')
  await createNote(page, 'Idle plan')
  await sidebar(page)
    .getByRole('button', { name: /^Active 1$/ })
    .click()
  await expect(header(page)).toHaveText('Active')

  await page.keyboard.press('Meta+Shift+KeyF')
  await expect(search(page)).toHaveAttribute('placeholder', 'Filter')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('In Active · 1 note')
  await expect(noteRows(page)).toHaveText([/^Active plan/])
})

test('the view a search narrows is named as typed', async ({ page }) => {
  // A string replacement would read $$ and $& as patterns.
  await createBook(page, 'Make $$ $&')
  await createNote(page, 'Kit plan')
  await page.keyboard.press('Meta+Shift+KeyF')
  await expect(search(page)).toHaveAttribute('placeholder', 'Filter')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('In Make $$ $& · 1 note')
})

test('/ in the note list focuses the search field for the current view', async ({ page }) => {
  await createBook(page, 'Work')
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await noteRows(page).first().click()
  await expect(noteRows(page).first()).toBeFocused()

  await page.keyboard.press('/')
  await expect(search(page)).toBeFocused()
  // The key only moves the focus; nothing is typed.
  await expect(search(page)).toHaveValue('')
  await expect(search(page)).toHaveAttribute('placeholder', 'Filter')
  await page.keyboard.type('alp')
  await expect(noteRows(page)).toHaveText([/^Alpha/])

  // A slash typed in the field is text.
  await page.keyboard.type('/')
  await expect(search(page)).toHaveValue('alp/')
})

test('qualifiers and exclusions narrow the results', async ({ page }) => {
  await createNote(page, 'Loose plan', 'relay notes')
  await createBook(page, 'Weekly notes')
  await createNote(page, 'Week plan', 'relay later')
  await createNote(page, 'Old plan', 'archived')
  await showAllNotes(page)

  await search(page).fill('plan book:"weekly NOTES"')
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(2)
  await search(page).fill('plan book:"weekly NOTES" -archived')
  await expect(noteRows(page)).toHaveText([/^Week plan/])
  await search(page).fill('body:relay -title:week')
  await expect(noteRows(page)).toHaveText([/^Loose plan/])
  // Malformed input is searched as text, never an error.
  await search(page).fill('status:"later')
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(0)
})

test('matched words are highlighted in titles and body excerpts', async ({ page }) => {
  await createNote(page, 'Relay design', 'Notes on the WebSocket relay and its backoff.')
  await createNote(page, '<b>Bold</b> relay', '')
  await search(page).fill('relay -nothing')
  await expect(noteRows(page)).toHaveCount(2)

  const design = noteRows(page).filter({ hasText: 'Relay design' })
  await expect(design.locator('.row-title mark')).toHaveText(['Relay'])
  await expect(design.locator('.row-excerpt')).toHaveText(
    'Notes on the WebSocket relay and its backoff.',
  )
  await expect(design.locator('.row-excerpt mark')).toHaveText(['relay'])

  // Note text is only ever text: markup in a title is shown, not rendered.
  const bold = noteRows(page).filter({ hasText: '<b>Bold</b>' })
  await expect(bold.locator('.row-title')).toHaveText('<b>Bold</b> relay')
  await expect(bold.locator('b')).toHaveCount(0)
  await expect(bold.locator('.row-excerpt')).toHaveCount(0)

  // A qualified word is marked only in the field it names.
  await search(page).fill('title:design')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(design.locator('mark')).toHaveText(['design'])
  await expect(design.locator('.row-excerpt mark')).toHaveCount(0)

  // Excluded words are not marked, even where the exclusion does not look:
  // WebSocket is in an excerpt and Bold in a title of rows still found.
  // (Two rows again: the marks below belong to this query's results.)
  await search(page).fill('relay -title:websocket -body:bold')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(design.locator('.row-excerpt')).toHaveText(
    'Notes on the WebSocket relay and its backoff.',
  )
  await expect(design.locator('mark')).toHaveText(['Relay', 'relay'])
  await expect(bold.locator('.row-title')).toHaveText('<b>Bold</b> relay')
  await expect(bold.locator('mark')).toHaveText(['relay'])
})

test('searching from the Trash shows live notes outside the Trash', async ({ page }) => {
  await createNote(page, 'Kept plan')
  await sidebar(page)
    .getByRole('button', { name: /^Trash/ })
    .click()
  await expect(header(page)).toHaveText('Trash')
  await page.keyboard.press('Meta+Shift+KeyF')
  await expect(search(page)).toHaveAttribute('placeholder', 'Search')
  await page.keyboard.type('plan')
  await expect(noteRows(page)).toHaveText([/^Kept plan/])
  await noteRows(page).first().click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Kept plan')
})

test('excerpts read as text: no front matter and no Markdown markers', async ({ page }) => {
  await createNote(
    page,
    'Launch',
    [
      '---',
      'title: Launch plan',
      'tags: [work, q4]',
      '---',
      '![Board](board.png)',
      '# Inbox',
      '- See [[Plan]] and the **launch** [checklist](https://devot.app/list)',
    ].join('\n'),
  )
  await search(page).fill('checklist')
  await expect(header(page)).toHaveText('Search')
  const row = noteRows(page).filter({ hasText: 'Launch' })
  await expect(row.locator('.row-excerpt')).toHaveText(
    'Board Inbox See Plan and the launch checklist',
  )
  await expect(row.locator('.row-excerpt mark')).toHaveText(['checklist'])

  // A word the front matter holds finds the note, with no excerpt from it.
  await search(page).fill('q4')
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(row.locator('.row-excerpt mark')).toHaveCount(0)
})

test('searching every note shows nothing in the sidebar as selected until it is cleared', async ({
  page,
}) => {
  // What the sidebar shows as selected: the notebook, All Notes, a filter.
  const selected = sidebar(page).locator(
    '[aria-current="true"], [aria-selected="true"], [aria-pressed="true"]',
  )
  await createBook(page, 'Work')
  await createNote(page, 'Work plan')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await createNote(page, 'Idle plan')

  // Every note, from the notebook: the notebook no longer looks selected.
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')
  await expect(selected).toHaveCount(0)

  // The same words in the notebook keep it selected.
  await page.keyboard.press('Meta+Shift+KeyF')
  await expect(caption(page)).toHaveText('In Work · 2 notes')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(selected).toHaveCount(1)

  // Every note again, then cleared: the notebook is selected again.
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(selected).toHaveCount(0)
  await search(page).press('Escape')
  await expect(header(page)).toHaveText('Work')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(selected).toHaveCount(1)

  // Searching the notebook right after: it never stops looking selected,
  // although the list shows the last results for a moment.
  await page.evaluate(`(() => {
    window.devotSelectionLost = false
    const row = [...document.querySelectorAll('[role=treeitem]')]
      .find((el) => el.textContent.startsWith('Work'))
    new MutationObserver(() => {
      if (row.getAttribute('aria-selected') !== 'true') window.devotSelectionLost = true
    }).observe(row, { attributes: true, attributeFilter: ['aria-selected'] })
  })()`)
  await page.keyboard.press('Meta+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('In Work · 2 notes')
  expect(await page.evaluate('window.devotSelectionLost')).toBe(false)
  await search(page).press('Escape')
  await expect(header(page)).toHaveText('Work')

  // A filter: typing in the field searches every note, and the filter no
  // longer looks pressed; clearing the field shows it pressed again.
  await noteRows(page).filter({ hasText: 'Work plan' }).click()
  await pickStatus(page, 'Active')
  const active = sidebar(page).getByRole('button', { name: /^Active 1$/ })
  await active.click()
  await expect(header(page)).toHaveText('Active')
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(active).toHaveAttribute('aria-pressed', 'false')
  await expect(selected).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear Search' }).click()
  await expect(header(page)).toHaveText('Active')
  await expect(active).toHaveAttribute('aria-pressed', 'true')

  // A sidebar row pressed during such a search shows that view, without
  // the filter that did not show as pressed.
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await active.click()
  await expect(header(page)).toHaveText('Active')
  await expect(search(page)).toHaveValue('')
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await book(page, 'Work').locator('> .book-row').click()
  await expect(header(page)).toHaveText('Work')
  await expect(search(page)).toHaveValue('')
  await expect(active).toHaveAttribute('aria-pressed', 'false')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
})

test('a filter pressed while searching every note leaves the hidden notebook', async ({ page }) => {
  const selected = sidebar(page).locator(
    '[aria-current="true"], [aria-selected="true"], [aria-pressed="true"]',
  )
  const active = sidebar(page).getByRole('button', { name: /^Active 2$/ })
  await createNote(page, 'Loose plan')
  await pickStatus(page, 'Active')
  await createBook(page, 'Work')
  await createNote(page, 'Work plan')
  await pickStatus(page, 'Active')
  await expect(header(page)).toHaveText('Work')

  // Shift+Opt+Cmd+F searches every note: the notebook no longer looks
  // selected, so a filter pressed now covers every note.
  await page.keyboard.press('Meta+Alt+Shift+KeyF')
  await page.keyboard.type('plan')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')
  await active.click()
  await expect(search(page)).toHaveValue('')
  await expect(header(page)).toHaveText('Active')
  await expect(caption(page)).toHaveText('2 notes')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(active).toHaveAttribute('aria-pressed', 'true')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')
  // Only the filter looks selected: it covers every note, as All Notes does.
  await expect(selected).toHaveCount(1)
})
