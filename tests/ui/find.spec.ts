import type { Page } from '@playwright/test'
import { changeShortcutsElsewhere, expect, test, pickNoteMore } from './fixtures'

// Find and replace in the open note. The find shortcuts are window-wide app
// shortcuts that check the Command key, so these tests press Meta on every
// platform; the editor's own keys (undo) use ControlOrMeta.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const bar = (page: Page) => page.getByRole('search', { name: 'Find in Note' })
const findField = (page: Page) => bar(page).getByRole('textbox', { name: 'Find' })
const replaceField = (page: Page) => bar(page).getByRole('textbox', { name: 'Replace' })
const findStatus = (page: Page) => bar(page).getByRole('status')
const barButton = (page: Page, name: string) => bar(page).getByRole('button', { name, exact: true })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })

/** The saved body of the note with this title (what the store holds). */
const savedBody = (page: Page, title: string) =>
  page.evaluate((t) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      title: string
      bodyMd: string
    }[]
    return notes.find((n) => n.title === t)?.bodyMd
  }, title)

async function newNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await body(page).click()
  // Inserted at once, so the editor's bracket helpers do not interfere.
  await page.keyboard.insertText(text)
  await expect.poll(() => savedBody(page, title)).toBe(text)
}

/** Sizes of the preview's find highlights: all matches, and the current one. */
const previewHighlights = (page: Page) =>
  page.evaluate(() => {
    const registry = (
      globalThis as unknown as { CSS: { highlights: Map<string, { size: number }> } }
    ).CSS.highlights
    return [registry.get('devot-find')?.size ?? 0, registry.get('devot-find-current')?.size ?? 0]
  })

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, (route) => route.abort())
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Cmd+F finds in the note; Cmd+G steps through matches; Escape returns to the editor', async ({
  page,
}) => {
  await newNote(page, 'Find', 'one two one\nthree one')
  await expect(bar(page)).toHaveCount(0)

  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toBeFocused()
  await expect(replaceField(page)).toHaveCount(0)
  await page.keyboard.type('one')
  // Matches are marked; the one after the cursor (wrapping) is current.
  await expect(findStatus(page)).toHaveText('1 of 3')
  await expect(page.locator('.cm-find-match')).toHaveCount(3)
  await expect(page.locator('.cm-find-current')).toHaveCount(1)

  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('2 of 3')
  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('3 of 3')
  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('1 of 3')
  await page.keyboard.press('Shift+Meta+g')
  await expect(findStatus(page)).toHaveText('3 of 3')
  // Return and Shift+Return in the field, and the buttons, do the same.
  await page.keyboard.press('Shift+Enter')
  await expect(findStatus(page)).toHaveText('2 of 3')
  await page.keyboard.press('Enter')
  await expect(findStatus(page)).toHaveText('3 of 3')
  await barButton(page, 'Previous Match').click()
  await expect(findStatus(page)).toHaveText('2 of 3')
  await barButton(page, 'Next Match').click()
  await expect(findStatus(page)).toHaveText('3 of 3')
  await expect(findField(page)).toHaveValue('one')

  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(body(page)).toBeFocused()
  await expect(page.locator('.cm-find-match')).toHaveCount(0)
  // The last match stays selected, so typing replaces it.
  await page.keyboard.type('four')
  await expect.poll(() => savedBody(page, 'Find')).toBe('one two one\nthree four')
})

test('the count follows edits, and Cmd+F again picks up the selection', async ({ page }) => {
  await newNote(page, 'Live', 'alpha beta')
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('alpha')
  await expect(findStatus(page)).toHaveText('1 of 1')

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(' alpha')
  await expect(findStatus(page)).toHaveText('2 matches')
  await expect(page.locator('.cm-find-match')).toHaveCount(2)
  // F3 and Shift+F3 in the editor step through the matches too.
  await page.keyboard.press('F3')
  await expect(findStatus(page)).toHaveText('1 of 2')
  await page.keyboard.press('Shift+F3')
  await expect(findStatus(page)).toHaveText('2 of 2')
  // Escape with the editor focused closes the bar too, once the editor's
  // own popups are gone (a word completion may still be pending from typing;
  // moving the cursor ends it).
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)

  // A word selected in the editor becomes the query.
  const beta = page.locator('.cm-line').getByText('alpha beta alpha')
  await beta.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toHaveValue('alpha beta alpha')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await page.keyboard.press('Escape')
  await expect(body(page)).toBeFocused()
  // With the bar closed, F3 does not open the editor's built-in search.
  await page.keyboard.press('F3')
  await expect(page.locator('.cm-search')).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
})

test('Opt+Cmd+F replaces one match, then all of them as one undo step', async ({ page }) => {
  await newNote(page, 'Pets', 'cat Cat cat dog')
  await page.keyboard.press('ControlOrMeta+Home')

  await page.keyboard.press('Alt+Meta+f')
  await expect(findField(page)).toBeFocused()
  await page.keyboard.type('cat')
  await expect(findStatus(page)).toHaveText('1 of 3')
  await replaceField(page).fill('bird')

  await barButton(page, 'Replace').click()
  expect(await lines(page)).toEqual(['bird Cat cat dog'])
  // The next match is current, ready to replace.
  await expect(findStatus(page)).toHaveText('1 of 2')

  await barButton(page, 'Replace All').click()
  expect(await lines(page)).toEqual(['bird bird bird dog'])
  await expect(findStatus(page)).toHaveText('No matches')
  // Every replacement reaches the stored note, like any edit.
  await expect.poll(() => savedBody(page, 'Pets')).toBe('bird bird bird dog')

  await page.keyboard.press('Escape')
  await expect(body(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['bird Cat cat dog'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['cat Cat cat dog'])
  await expect.poll(() => savedBody(page, 'Pets')).toBe('cat Cat cat dog')
})

test('each replacement is its own undo step, however quick', async ({ page }) => {
  await newNote(page, 'Quick', 'a a a')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Alt+Meta+f')
  await page.keyboard.type('a')
  await expect(findStatus(page)).toHaveText('1 of 3')
  await replaceField(page).fill('b')
  // Return in the replace field replaces the current match and goes on.
  await replaceField(page).press('Enter')
  await replaceField(page).press('Enter')
  expect(await lines(page)).toEqual(['b b a'])
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['b a a'])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['a a a'])
})

test('regular expression and case toggles; an invalid pattern shows an error', async ({ page }) => {
  // A bad pattern must never throw. (The dev server can fail a lazy module
  // load under heavy test load; that is not this feature's error.)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => {
    if (!error.message.startsWith('Importing a module script failed'))
      pageErrors.push(error.message)
  })
  await newNote(page, 'Items', 'Item 1\nitem 22\nITEM 333')
  await page.keyboard.press('Alt+Meta+f')
  await page.keyboard.type('item')
  await expect(findStatus(page)).toHaveText('1 of 3')

  const matchCase = barButton(page, 'Match Case')
  const regexp = barButton(page, 'Regular Expression')
  await page.keyboard.press('Alt+Meta+c')
  await expect(matchCase).toHaveAttribute('aria-pressed', 'true')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await page.keyboard.press('Alt+Meta+c')
  await expect(matchCase).toHaveAttribute('aria-pressed', 'false')
  // The search goes on from the current match.
  await expect(findStatus(page)).toHaveText('2 of 3')

  // As plain text, regular expression syntax is literal.
  await findField(page).fill('\\d+')
  await expect(findStatus(page)).toHaveText('No matches')
  await page.keyboard.press('Alt+Meta+r')
  await expect(regexp).toHaveAttribute('aria-pressed', 'true')
  await expect(findStatus(page)).toHaveText(/of 3$/)

  await findField(page).fill('(')
  await expect(findStatus(page)).toHaveText('Invalid regular expression')
  await expect(findField(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.cm-find-match')).toHaveCount(0)
  await expect(barButton(page, 'Replace All')).toBeDisabled()
  await expect(barButton(page, 'Next Match')).toBeDisabled()
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['Item 1', 'item 22', 'ITEM 333'])

  // Groups go into the replacement.
  await findField(page).fill('^(\\w+) (\\d+)$')
  await expect(findField(page)).not.toHaveAttribute('aria-invalid', 'true')
  await replaceField(page).fill('$2. $1')
  await barButton(page, 'Replace All').click()
  expect(await lines(page)).toEqual(['1. Item', '22. item', '333. ITEM'])
  // The toggles work with the buttons too.
  await regexp.click()
  await expect(regexp).toHaveAttribute('aria-pressed', 'false')
  await matchCase.click()
  await expect(matchCase).toHaveAttribute('aria-pressed', 'true')
  // Nothing threw on the way.
  expect(pageErrors).toEqual([])
})

test('in preview mode, Cmd+F searches the rendered text and highlights it', async ({ page }) => {
  await newNote(page, 'Rendered', '# Notes\n\nSome **bold** text and more text.\n\n- a text item')
  await mode(page, 'Preview').click()
  await expect(preview(page).getByRole('heading', { name: 'Notes' })).toBeVisible()

  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toBeFocused()
  await page.keyboard.type('text')
  await expect(findStatus(page)).toHaveText('1 of 3')
  await expect.poll(() => previewHighlights(page)).toEqual([2, 1])
  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('2 of 3')

  // The rendered text, not the Markdown: across formatting, without markers.
  await findField(page).fill('bold text')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await findField(page).fill('**')
  await expect(findStatus(page)).toHaveText('No matches')
  await expect.poll(() => previewHighlights(page)).toEqual([0, 0])
  // The preview cannot be edited, so there is no replace.
  await page.keyboard.press('Alt+Meta+f')
  await expect(replaceField(page)).toHaveCount(0)

  await findField(page).fill('item')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(preview(page)).toBeFocused()
  await expect.poll(() => previewHighlights(page)).toEqual([0, 0])
})

test('the preview highlights follow the text as it changes', async ({ page }) => {
  await newNote(page, 'Changing', 'one\n\none')
  await mode(page, 'Split').click()
  await expect(preview(page).locator('p')).toHaveCount(2)
  await preview(page).locator('p').first().click()
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('one')
  await expect(findStatus(page)).toHaveText('1 of 2')
  await expect.poll(() => previewHighlights(page)).toEqual([1, 1])
  // The editor is not searched meanwhile.
  await expect(page.locator('.cm-find-match')).toHaveCount(0)

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n\none')
  await expect(preview(page).locator('p')).toHaveCount(3)
  await expect(findStatus(page)).toHaveText('1 of 3')
  await expect.poll(() => previewHighlights(page)).toEqual([2, 1])
})

test('a hard line break in the preview separates the text around it', async ({ page }) => {
  // Two trailing spaces: a hard break, rendered as <br>.
  await newNote(page, 'Break', 'alpha  \nbeta')
  await mode(page, 'Preview').click()
  await expect(preview(page).locator('br')).toHaveCount(1)
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('alphabeta')
  await expect(findStatus(page)).toHaveText('No matches')
  await page.keyboard.press('Alt+Meta+r')
  await findField(page).fill('^beta')
  await expect(findStatus(page)).toHaveText('1 of 1')
})

test('in split mode, Cmd+F searches the pane that has focus', async ({ page }) => {
  await newNote(page, 'Split', 'Some *word* here')
  await mode(page, 'Split').click()
  await expect(preview(page).locator('em')).toHaveText('word')

  // From the editor: the Markdown source.
  await body(page).click()
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('*word*')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await expect(page.locator('.cm-find-match')).toHaveCount(1)
  await expect.poll(() => previewHighlights(page)).toEqual([0, 0])

  // From the preview: the rendered text, which has no asterisks.
  await preview(page).locator('em').click()
  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toBeFocused()
  await expect(findStatus(page)).toHaveText('No matches')
  await findField(page).fill('word')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await expect.poll(() => previewHighlights(page)).toEqual([0, 1])
  await expect(page.locator('.cm-find-match')).toHaveCount(0)
})

test('find stays out of the way of the other shortcuts', async ({ page }) => {
  await newNote(page, 'Keys', 'text')
  // Shift+Cmd+F still searches the current view, not the note.
  await page.keyboard.press('Shift+Meta+f')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
  await expect(bar(page)).toHaveCount(0)
  // The toggles do nothing while the bar is closed.
  await body(page).click()
  await page.keyboard.press('Alt+Meta+c')
  await page.keyboard.press('Alt+Meta+r')
  await expect(bar(page)).toHaveCount(0)
  // With no note open, Cmd+F does nothing.
  await pickNoteMore(page, 'Move to Trash')
  await expect(noteRows(page)).toHaveCount(0)
  await page.keyboard.press('Meta+f')
  await expect(bar(page)).toHaveCount(0)
})

test('Cmd+G with the bar closed goes on to the next match with the same query', async ({
  page,
}) => {
  await newNote(page, 'Again', 'a 1 b 22 c 333')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Meta+f')
  await page.keyboard.press('Alt+Meta+r')
  await page.keyboard.type('\\d+')
  await expect(findStatus(page)).toHaveText('1 of 3')

  // Escape leaves the match selected; that selection is not a new query.
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await page.keyboard.press('Meta+g')
  await expect(findField(page)).toHaveValue('\\d+')
  await expect(findStatus(page)).toHaveText('2 of 3')

  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Meta+g')
  await expect(findField(page)).toHaveValue('\\d+')
  await expect(findStatus(page)).toHaveText('1 of 3')

  // Cmd+F reopens on the same match and keeps the query.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+f')
  await expect(findField(page)).toHaveValue('\\d+')
  await expect(findStatus(page)).toHaveText('1 of 3')
})

test('Cmd+G with the bar closed goes on from the cursor in plain text', async ({ page }) => {
  await newNote(page, 'Plain', 'one two one three one')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('one')
  await expect(findStatus(page)).toHaveText('1 of 3')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('2 of 3')
  await expect(findField(page)).toHaveValue('one')

  // From a cursor between matches, the next one after it.
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Meta+g')
  await expect(findStatus(page)).toHaveText('1 of 3')
})

test("CodeMirror's Go to Line and search panel never open, even on a freed Find Next key", async ({
  page,
}) => {
  await newNote(page, 'Panels', 'one two one')
  const panels = page.locator('.cm-panels, .cm-search, .cm-gotoLine, .cm-panel')
  // Go to Line is Alt+G (Cmd+Option+G on macOS).
  for (const keys of ['Alt+g', 'ControlOrMeta+Alt+g']) {
    await page.keyboard.press(keys)
    await expect(panels).toHaveCount(0)
  }
  // Find Next moved to another key leaves Cmd+G free, which CodeMirror's own
  // Find Next would take (and open its panel with).
  await changeShortcutsElsewhere(page, { 'find.next': ['Mod+Shift+J'] })
  for (const keys of ['Meta+g', 'ControlOrMeta+g', 'F3', 'ControlOrMeta+f']) {
    await page.keyboard.press(keys)
    await expect(panels).toHaveCount(0)
  }
})

test('replacing from the keyboard keeps Escape working', async ({ page }) => {
  await newNote(page, 'Keyboard', 'cat cat')
  await page.keyboard.press('Alt+Meta+f')
  await page.keyboard.type('cat')
  await expect(findStatus(page)).toHaveText(/of 2$/)
  await replaceField(page).fill('dog')
  await barButton(page, 'Replace All').focus()
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['dog dog'])
  await expect(findStatus(page)).toHaveText('No matches')
  await expect(barButton(page, 'Replace All')).toBeDisabled()
  // A button with nothing left to do still holds the focus, so Escape closes.
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(body(page)).toBeFocused()
})

test('a soft line break between formatted words is a space in the preview', async ({ page }) => {
  await newNote(page, 'Soft', '*a*\n*b*\n\n**c**\n**d**')
  await mode(page, 'Preview').click()
  await expect(preview(page).locator('em')).toHaveCount(2)
  await page.keyboard.press('Meta+f')
  await page.keyboard.type('a b')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await findField(page).fill('c d')
  await expect(findStatus(page)).toHaveText('1 of 1')
  await findField(page).fill('ab')
  await expect(findStatus(page)).toHaveText('No matches')
  // Between blocks it is still a line break, not a space.
  await findField(page).fill('b c')
  await expect(findStatus(page)).toHaveText('No matches')
})
