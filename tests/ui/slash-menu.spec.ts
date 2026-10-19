import type { Page } from '@playwright/test'
import { changeShortcutsElsewhere, expect, test } from './fixtures'

// The slash menu: `/` at the start of a line lists the insertions in three
// groups; the query filters them (a substring of the label), Return inserts,
// Escape closes the list and keeps the text, and a query that matches
// nothing closes it for that slash. Keys are platform-neutral (ControlOrMeta
// for the command key, no macOS text-navigation keys), so the tests run the
// same on Linux.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete')
const options = (page: Page) => popup(page).getByRole('option')
const headers = (page: Page) => popup(page).locator('completion-section')
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

async function typeQuery(page: Page, query: string) {
  await page.keyboard.type(`/${query}`)
}

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
  ['blockq', 'Blockquote', ['Intro', '', '> x']],
  ['heading 2', 'Heading 2', ['Intro', '', '## x']],
  ['link', 'Link', ['Intro', '', '[x]()']],
  ['caution', 'Caution', ['Intro', '', '> [!CAUTION]', '> x']],
  ['tip', 'Tip', ['Intro', '', '> [!TIP]', '> x']],
  ['ordered', 'Ordered List', ['Intro', '', '1. x']],
  ['task', 'Task List', ['Intro', '', '* [ ] x']],
  ['unordered', 'Unordered List', ['Intro', '', '* x']],
]

for (const [query, label, expected] of KINDS) {
  test(`Return inserts ${label} in place of the typed query`, async ({ page }) => {
    await newNote(page, 'Intro\n\n')
    await typeQuery(page, query)
    await waitForFirst(page, label)
    await page.keyboard.press('Enter')
    await expect(popup(page)).toBeHidden()
    await page.keyboard.insertText('x')
    expect(await lines(page)).toEqual(expected)
  })
}

test('the menu lists its items in groups and filters by substring', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, '')
  await waitForFirst(page, 'Blockquote')
  await expect(headers(page)).toHaveText(['Basic Formatting', 'Alerts', 'Other'])
  await expect(options(page)).toHaveCount(19)
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(options(page).first()).toContainText('> Quote')
  await page.keyboard.press('ArrowUp')
  await expect(options(page).last()).toHaveAttribute('aria-selected', 'true')
  await expect(options(page).last()).toContainText('Note Link')

  await page.keyboard.type('ist')
  await waitForFirst(page, 'Task List')
  expect(await options(page).locator('.cm-completionLabel').allTextContents()).toEqual([
    'Task List',
    'Ordered List',
    'Unordered List',
  ])
  await expect(headers(page)).toHaveText(['Basic Formatting'])
  await expect(options(page).first().locator('.cm-completionMatchedText')).toHaveText('ist')
})

test('Codeblock writes the fences and opens the language list', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, '')
  await waitForFirst(page, 'Blockquote')
  await page.keyboard.type('co')
  await waitForFirst(page, 'Codeblock')
  await expect(options(page)).toHaveCount(1)
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['```', '', '```'])
  // The language list opens at once, right after the opening fence.
  await expect(options(page).first()).toContainText('```')
  await page.keyboard.type('rust')
  await waitForFirst(page, '```rust')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toBeHidden()
  await page.keyboard.insertText(':main.rs')
  expect(await lines(page)).toEqual(['```rust:main.rs', '', '```'])
})

test('a slash after other text opens nothing', async ({ page }) => {
  await newNote(page, 'x ')
  await typeQuery(page, '')
  await settle(page)
  await expect(popup(page)).toHaveCount(0)
  expect(await lines(page)).toEqual(['x /'])
})

test('a query that matches nothing closes the menu, and Backspace does not reopen it', async ({
  page,
}) => {
  await newNote(page, '')
  await typeQuery(page, 'h')
  await waitForFirst(page, 'Heading 1')
  await page.keyboard.type('d')
  await expect(popup(page)).toBeHidden()
  await page.keyboard.press('Backspace')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/h'])
  await page.keyboard.press('Enter')
  await typeQuery(page, '')
  await waitForFirst(page, 'Blockquote')
})

test('Escape closes the menu and keeps the text', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'li')
  await waitForFirst(page, 'Link')
  await page.keyboard.press('Escape')
  await expect(popup(page)).toBeHidden()
  await page.keyboard.type('nk')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/link'])
})

test('the menu stays closed for its slash after the editor loses the focus', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'he')
  await waitForFirst(page, 'Heading 1')
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(popup(page)).toBeHidden()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('a')
  await settle(page)
  await expect(popup(page)).toBeHidden()
  expect(await lines(page)).toEqual(['/hea'])
})

test('an empty line shows the slash hint, an empty note the template chip', async ({ page }) => {
  await newNote(page, '')
  const chip = page.getByRole('button', { name: /^Choose a template/ })
  await expect(chip).toBeVisible()
  await page.keyboard.insertText('Intro\n')
  await expect(chip).toBeHidden()
  await expect(page.locator('.cm-line.cm-slash-hint')).toHaveAttribute(
    'data-hint',
    "Type '/' for commands...",
  )
  expect(await lines(page)).toEqual(['Intro', ''])
})

test('a pick is one undo step that brings the query back', async ({ page }) => {
  await newNote(page, 'Intro\n\n')
  await typeQuery(page, 'blockq')
  await waitForFirst(page, 'Blockquote')
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['Intro', '', '> '])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['Intro', '', '/blockq'])
})

test('`:` and a shortcode list emoji; `> [!` lists the alert kinds', async ({ page }) => {
  await newNote(page, 'Done ')
  await page.keyboard.type(':tad')
  await waitForFirst(page, ':tada:')
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['Done \u{1f389}'])
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('> [!wa')
  await waitForFirst(page, '[!WARNING]')
  await page.keyboard.press('Enter')
  expect((await lines(page)).at(-1)).toBe('> [!WARNING]')
})

test('Return from an input method does not pick', async ({ page }) => {
  await newNote(page, '')
  await typeQuery(page, 'blockq')
  await waitForFirst(page, 'Blockquote')
  // The Return that ends a composition (WebKit may report it after compositionend).
  const handled = await body(page).evaluate((el) => {
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
  expect(await lines(page)).toEqual(['/blockq'])
  await page.keyboard.press('Enter')
  expect(await lines(page)).toEqual(['> '])
})

test('Note Link from the palette opens the note search', async ({ page }) => {
  await newNote(page, 'Plan')
  await page.locator('.cm-line').first().dblclick()
  await page.keyboard.press('Meta+KeyK')
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
  await page.keyboard.press('Meta+KeyK')
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
  await changeShortcutsElsewhere(page, { 'insert.table': ['Mod+Alt+T'] })
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Alt+KeyT')
  await expect
    .poll(() => lines(page))
    .toEqual(['Intro', '', '|     |     |', '| --- | --- |', '|     |     |'])
})
