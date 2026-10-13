import type { Page } from '@playwright/test'
import { changeShortcutsElsewhere, expect, test } from './fixtures'

// The slash menu: `/` at the start of a line or after a space lists the
// insertions; the query filters them, Return inserts, Escape or a space
// closes the list and keeps the text. Keys are platform-neutral (ControlOrMeta
// for the command key, no macOS text-navigation keys), so the tests run the
// same on Linux.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete')
const options = (page: Page) => popup(page).getByRole('option')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })
const commandOptions = (page: Page) =>
  palette(page).getByRole('group', { name: 'Commands' }).getByRole('option')

async function newNote(page: Page, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  if (text) await page.keyboard.insertText(text)
}

/**
 * Waits for the list to show `label` first and to take keys: past the
 * running queries (the list is disabled meanwhile) and CodeMirror's
 * `interactionDelay` (75 ms), during which keys go to the editor instead.
 */
async function waitForFirst(page: Page, label: string) {
  await expect(options(page).first()).toContainText(label)
  await expect(popup(page)).not.toHaveClass(/cm-tooltip-autocomplete-disabled/)
  await page.waitForTimeout(150)
}

/** Types a `/query` as keys, as a user does. */
async function typeQuery(page: Page, query: string) {
  await page.keyboard.type(`/${query}`)
}

/** Waits long enough for a list that would open to open. */
async function settle(page: Page) {
  await page.waitForTimeout(400)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

// The query typed after the slash, the item it puts first, and the lines
// after Return and typing `x` where the cursor went.
const KINDS: [string, string, string[]][] = [
  ['link', 'Link', ['Intro', '[x]()']],
  ['image', 'Image', ['Intro', '![x]()']],
  ['quote', 'Quote', ['Intro', '> x']],
  ['notea', 'Note Alert', ['Intro', '> [!NOTE]', '> x']],
  ['tip', 'Tip Alert', ['Intro', '> [!TIP]', '> x']],
  ['important', 'Important Alert', ['Intro', '> [!IMPORTANT]', '> x']],
  ['warning', 'Warning Alert', ['Intro', '> [!WARNING]', '> x']],
  ['caution', 'Caution Alert', ['Intro', '> [!CAUTION]', '> x']],
  ['code', 'Code Block', ['Intro', '```', 'x', '```']],
  ['table', 'Table', ['Intro', '', '| x    |     |', '| --- | --- |', '|     |     |']],
  ['bullet', 'Bulleted List', ['Intro', '- x']],
  ['numbered', 'Numbered List', ['Intro', '1. x']],
  ['task', 'Task List', ['Intro', '- [ ] x']],
  ['rule', 'Horizontal Rule', ['Intro', '', '---', 'x']],
]

for (const [query, label, expected] of KINDS) {
  test(`Return inserts ${label} in place of the typed query`, async ({ page }) => {
    await newNote(page, 'Intro\n')
    await typeQuery(page, query)
    await waitForFirst(page, label)
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeHidden()
    await page.keyboard.insertText('x')
    expect(await lines(page)).toEqual(expected)
  })
}

test('Code Block in a list item goes inside the item, keeping its marker', async ({ page }) => {
  await newNote(page, '1. Run this:')
  await page.keyboard.press('Enter')
  await typeQuery(page, 'code')
  await waitForFirst(page, 'Code Block')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toBeHidden()
  await page.keyboard.insertText('make')
  expect(await lines(page)).toEqual(['1. Run this:', '2. ```', '   make', '   ```'])
})

test('Note Link opens the note search where the query was', async ({ page }) => {
  await newNote(page, 'Intro\n')
  await typeQuery(page, 'notel')
  await waitForFirst(page, 'Note Link')
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['Intro', '[[]]'])
  // The `[[` popup opens with the pick, before anything is typed.
  await expect(popup(page).getByRole('option', { name: 'New Note', exact: true })).toBeVisible()
  // It takes over and searches for what is typed next.
  await page.keyboard.insertText('Plan B')
  await expect(popup(page).getByRole('option', { name: 'New Note “Plan B”' })).toBeVisible()
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  // By title: the source's excerpt shows the link's text too.
  await expect(
    noteRows(page).filter({ has: page.locator('.row-title', { hasText: 'Plan B' }) }),
  ).toHaveCount(1)
  await expect.poll(async () => (await lines(page))[1]).toMatch(/^\[Plan B\]\(devot:\/\/note\//)
})

test('Return right after the query is typed picks', async ({ page }) => {
  await newNote(page, 'Intro\n')
  await typeQuery(page, '')
  await waitForFirst(page, 'Link')
  // No wait between the last key and Return: the list ranks as keys come.
  await page.keyboard.type('table')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual([
    'Intro',
    '',
    '|     |     |',
    '| --- | --- |',
    '|     |     |',
  ])
})

test('the menu stays closed for its slash after the editor loses the focus', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'ta')
  await waitForFirst(page, 'Table')
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(popup(page)).toBeHidden()
  // Back in the body, typing on after that slash keeps the text.
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('b')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/tab'])
  // A new slash opens it again.
  await page.keyboard.type(' /')
  await waitForFirst(page, 'Link')
})

test('the menu lists every insertion and filters as the query is typed', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, '')
  await waitForFirst(page, 'Link')
  expect(await options(page).allTextContents()).toEqual([
    'Link⌘K',
    'Image',
    'Quote⇧⌘.',
    'Note Alert',
    'Tip Alert',
    'Important Alert',
    'Warning Alert',
    'Caution Alert',
    'Note Link',
    'Code Block⇧⌘C',
    'Table',
    'Bulleted List⇧⌘8',
    'Numbered List⇧⌘7',
    'Task List⇧⌘9',
    'Horizontal Rule⇧⌘-',
  ])
  await page.keyboard.type('al')
  await waitForFirst(page, 'Alert')
  expect(await options(page).count()).toBeLessThan(15)
  await page.keyboard.type('zzz')
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/alzzz'])
})

test('Escape and a space close the menu and keep the text', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'li')
  await waitForFirst(page, 'Link')
  await page.keyboard.press('Escape')
  await expect(popup(page)).toBeHidden()
  // Typing on after Escape keeps the menu closed for that slash.
  await page.keyboard.type('nk')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/link'])
  // A new slash opens it again; a space closes it.
  await page.keyboard.type(' /ta')
  await waitForFirst(page, 'Table')
  await page.keyboard.type(' ')
  await expect(popup(page)).toBeHidden()
  // Return after the space is a new line, not a pick.
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['/link /ta ', ''])
})

test('Escape right after typing still keeps the menu closed', async ({ page }) => {
  await newNote(page, '')
  // Escape before the list has caught up with the query.
  await typeQuery(page, 'ta')
  await page.keyboard.press('Escape')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  await page.keyboard.type('b')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/tab'])
})

test('a slash in a note link query stays with the note search', async ({ page }) => {
  await newNote(page, '')
  await page.keyboard.type('[[Q1 /')
  await expect(popup(page).getByRole('option', { name: 'New Note \u201cQ1 /\u201d' })).toBeVisible()
  await expect(popup(page).getByRole('option', { name: 'Table' })).toHaveCount(0)
  await expect(popup(page).getByRole('option')).toHaveCount(1)
})

test('the menu does not open in code or after other characters', async ({ page }) => {
  // In a fenced code block.
  await newNote(page, '```\ncode ')
  await typeQuery(page, '')
  await settle(page)
  await expect(popup(page)).toHaveCount(0)
  expect(await lines(page)).toEqual(['```', 'code /'])

  // In inline code: the cursor between `code ` and the closing backtick.
  await newNote(page, 'a `code ` b')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await typeQuery(page, '')
  await settle(page)
  await expect(popup(page)).toHaveCount(0)
  expect(await lines(page)).toEqual(['a `code /` b'])

  // After a character that is not a space: paths and fractions.
  await newNote(page, 'see src')
  await typeQuery(page, 'x')
  await settle(page)
  await expect(popup(page)).toHaveCount(0)

  // After a space it opens: the waits above were long enough to see it.
  await page.keyboard.type(' ')
  await typeQuery(page, '')
  await waitForFirst(page, 'Link')
})

test('a pick is one undo step that brings the query back', async ({ page }) => {
  await newNote(page, 'Intro\n')
  await typeQuery(page, 'quote')
  await waitForFirst(page, 'Quote')
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['Intro', '> '])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['Intro', '/quote'])
  // On Linux CodeMirror binds redo to Ctrl+Y (Ctrl+Shift+Z is undo there).
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  expect(await lines(page)).toEqual(['Intro', '> '])
})

test('Return from an input method does not pick', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'quo')
  await waitForFirst(page, 'Quote')
  // The Return that ends a composition (WebKit may report it after compositionend).
  const handled = await body(page).evaluate((el) => {
    // This config has no DOM types: the one browser class used here.
    const w = globalThis as unknown as {
      KeyboardEvent: new (type: string, init: object) => { defaultPrevented: boolean }
    }
    const init = { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true }
    const event = new w.KeyboardEvent('keydown', init)
    ;(el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(handled).toBe(false)
  await expect(popup(page)).toBeVisible()
  expect(await lines(page)).toEqual(['/quo'])
  // The next Return, outside the composition, picks.
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['> '])
})

test('Note Link from the palette opens the note search', async ({ page }) => {
  await newNote(page, 'Plan')
  // A double click selects the word, which becomes the query.
  await page.locator('.cm-line').first().dblclick()
  await page.keyboard.press('Meta+KeyP')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill('note link')
  await expect(commandOptions(page).first()).toContainText('Note Link')
  await paletteField(page).press('Enter')
  await expect(body(page)).toBeFocused()
  expect(await lines(page)).toEqual(['[[Plan]]'])
  await expect(popup(page).getByRole('option', { name: 'New Note \u201cPlan\u201d' })).toBeVisible()
})

test('the palette offers the insertions too', async ({ page }) => {
  await newNote(page, 'Intro')
  await page.keyboard.press('Meta+KeyP')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill('table')
  await expect(commandOptions(page).first()).toContainText('Table')
  await paletteField(page).press('Enter')
  await expect(body(page)).toBeFocused()
  expect(await lines(page)).toEqual([
    'Intro',
    '',
    '|     |     |',
    '| --- | --- |',
    '|     |     |',
  ])
})

test('a key the user gives an insertion inserts it', async ({ page }) => {
  await newNote(page, 'Intro')
  // What Rust sends every window after Settings > Keyboard Shortcuts stores it.
  await changeShortcutsElsewhere(page, { 'insert.table': ['Mod+Alt+T'] })
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Alt+KeyT')
  await expect
    .poll(() => lines(page))
    .toEqual(['Intro', '', '|     |     |', '| --- | --- |', '|     |     |'])
})
