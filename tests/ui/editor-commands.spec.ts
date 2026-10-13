import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  changeShortcutsElsewhere,
  expect,
  test,
  type TestWindow,
} from './fixtures'

// Editor commands: Insert Horizontal Rule, New Note from Selection, Paste as
// Plain Text, and pasting URLs. Editor keys use ControlOrMeta (CodeMirror's
// Mod); window keys use Meta, like the other specs. Selections come from
// clicks and Shift with Home, End or ControlOrMeta+End, never from macOS
// text-navigation keys, so the tests run the same on Linux.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const title = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n)
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })
const commandOptions = (page: Page) =>
  palette(page).getByRole('group', { name: 'Commands' }).getByRole('option')

async function newNote(page: Page, text: string, name?: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(title(page)).toHaveValue('')
  if (name !== undefined) {
    await title(page).fill(name)
    await expect(noteRows(page).filter({ hasText: name })).toHaveCount(1)
  }
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(line(page, 0)).toHaveText(text.split('\n')[0] ?? '')
}

/** Opens the palette with Cmd+P and types a query. */
async function search(page: Page, query: string) {
  await page.keyboard.press('Meta+KeyP')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill(query)
}

/** Selects a whole line's text. */
async function selectLine(page: Page, n: number) {
  await line(page, n).click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
}

/** Pastes plain text into the editor, as the system would. */
async function paste(page: Page, text: string) {
  await body(page).evaluate((el, value) => {
    // This config has no DOM types: the few browser classes used here.
    const w = globalThis as unknown as {
      DataTransfer: new () => { setData(type: string, value: string): void }
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const data = new w.DataTransfer()
    data.setData('text/plain', value)
    const init = { bubbles: true, cancelable: true, clipboardData: data }
    ;(el as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(
      new w.ClipboardEvent('paste', init),
    )
  }, text)
}

/** What the system clipboard holds, as `clipboard_read_text` reads it. */
const setClipboard = (page: Page, text: string) =>
  page.evaluate((value) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, clipboard_read_text: value }
  }, text)

const clipboardReads = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'clipboard_read_text',
      ).length,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Shift+Cmd+- inserts a horizontal rule under the line, and the palette offers it', async ({
  page,
}) => {
  await newNote(page, 'Above\nBelow')
  await line(page, 0).click()
  await page.keyboard.press('End')
  await page.keyboard.press('ControlOrMeta+Shift+Minus')
  expect(await lines(page)).toEqual(['Above', '', '---', '', 'Below'])
  // The cursor waits on the new line under the rule.
  await page.keyboard.insertText('typed')
  expect(await lines(page)).toEqual(['Above', '', '---', 'typed', 'Below'])
  // One undo step takes the rule back.
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['Above', 'Below'])

  await line(page, 1).click()
  await page.keyboard.press('End')
  await search(page, 'horizontal rule')
  await expect(commandOptions(page).first()).toContainText('Horizontal Rule')
  await expect(commandOptions(page).first()).toContainText('⇧⌘-')
  await paletteField(page).press('Enter')
  expect(await lines(page)).toEqual(['Above', 'Below', '', '---', ''])
  await expect(body(page)).toBeFocused()
  // Shift+Cmd+H is still Highlight.
  await line(page, 0).dblclick()
  await page.keyboard.press('ControlOrMeta+Shift+KeyH')
  await expect(line(page, 0)).toHaveText('<mark>Above</mark>')
  // The Format menu gets the rule's key while the editor has the keyboard.
  const keys = await page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((c) => c.cmd === 'format_menu_set')
        .at(-1)?.args['keys'] as Record<string, string>,
  )
  expect(keys['format.horizontalRule']).toBe('Shift+CmdOrCtrl+-')
})

test('New Note from Selection moves the text into a note and links to it', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const bookName = page.getByRole('textbox', { name: 'Notebook name' })
  await bookName.fill('Work')
  await bookName.press('Enter')
  const book = page
    .getByRole('tree', { name: 'Notebooks' })
    .getByRole('treeitem', { name: /^Work\b/ })
  await book.locator('> .book-row').click()
  await expect(noteRows(page)).toHaveCount(0)
  await newNote(page, 'Notes from the call\n## Follow-ups\nSend the deck', 'Meeting')

  // Nothing selected: the palette does not offer it.
  await search(page, 'new note from selection')
  await expect(commandOptions(page).filter({ hasText: 'New Note from Selection' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await line(page, 1).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('ControlOrMeta+Shift+End')
  await search(page, 'new note from selection')
  await expect(commandOptions(page).first()).toContainText('New Note from Selection')
  await paletteField(page).press('Enter')

  // The text left a link to the new note, and the source stays open.
  await expect(line(page, 1)).toHaveText(/^\[Follow-ups\]\(devot:\/\/note\/[0-9a-f-]{36}\)$/)
  expect(await lines(page)).toHaveLength(2)
  await expect(line(page, 0)).toHaveText('Notes from the call')
  await expect(title(page)).toHaveValue('Meeting')
  await expect(body(page)).toBeFocused()
  // The new note is in the same notebook, titled after the text's first line.
  await expect(noteRows(page)).toHaveCount(2)
  // By title: the source's excerpt shows the link's text too.
  const followUps = noteRows(page).filter({
    has: page.locator('.row-title', { hasText: 'Follow-ups' }),
  })
  await expect(followUps).toHaveCount(1)

  // One undo step puts the text back; the new note stays.
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(['Notes from the call', '## Follow-ups', 'Send the deck'])
  // Redo: Shift+Cmd+Z on macOS; CodeMirror binds Ctrl+Y elsewhere.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
  await expect(line(page, 1)).toHaveText(/^\[Follow-ups\]/)

  await followUps.click()
  await expect(title(page)).toHaveValue('Follow-ups')
  await expect.poll(() => lines(page)).toEqual(['## Follow-ups', 'Send the deck'])
})

test('Shift+Opt+Cmd+V pastes the clipboard text as it is', async ({ page }) => {
  await newNote(page, 'Read the docs today')
  await setClipboard(page, 'https://example.com')
  // A word selected: a usual paste of a URL would make it a link.
  await line(page, 0).dblclick({ position: { x: 14, y: 4 } })
  await page.keyboard.press('ControlOrMeta+Alt+Shift+KeyV')
  await expect.poll(() => clipboardReads(page)).toBe(1)
  await expect(line(page, 0)).toHaveText(/^https:\/\/example\.com the docs today$/)

  // From the palette too, with Markdown and line breaks kept as they are.
  await setClipboard(page, '**bold**\r\n[x](y)')
  await page.keyboard.press('End')
  await search(page, 'paste as plain')
  await expect(commandOptions(page).first()).toContainText('Paste as Plain Text')
  await expect(commandOptions(page).first()).toContainText('⌥⇧⌘V')
  await paletteField(page).press('Enter')
  await expect
    .poll(() => lines(page))
    .toEqual(['https://example.com the docs today**bold**', '[x](y)'])
  await expect(body(page)).toBeFocused()
})

test('keys set in Settings run New Note from Selection and Paste as Plain Text', async ({
  page,
}) => {
  await newNote(page, 'Keep this\nMove this', 'Source')
  // ControlOrMeta is Command on macOS and Control elsewhere. Shift+Cmd+K is
  // also CodeMirror's Delete Line, which the user's key must win over.
  const mod = process.platform === 'darwin' ? 'Mod' : 'Ctrl'
  await changeShortcutsElsewhere(page, {
    'note.newFromSelection': [`${mod}+Shift+J`],
    'edit.pastePlain': [`${mod}+Shift+K`],
  })

  // Nothing selected: the key does nothing.
  await line(page, 1).click()
  await page.keyboard.press('ControlOrMeta+Shift+KeyJ')
  await expect(noteRows(page)).toHaveCount(1)
  await selectLine(page, 1)
  await page.keyboard.press('ControlOrMeta+Shift+KeyJ')
  await expect(line(page, 1)).toHaveText(/^\[Move this\]\(devot:\/\/note\/[0-9a-f-]{36}\)$/)
  await expect(noteRows(page)).toHaveCount(2)

  await setClipboard(page, 'pasted')
  await line(page, 0).click()
  await page.keyboard.press('End')
  await page.keyboard.press('ControlOrMeta+Shift+KeyK')
  await expect.poll(() => clipboardReads(page)).toBe(1)
  await expect(line(page, 0)).toHaveText('Keep thispasted')
  expect(await lines(page)).toHaveLength(2)
})

test('a URL pasted over text links it; a lone URL goes in as the setting says', async ({
  page,
}) => {
  await newNote(page, 'See the docs\nlink: ')
  await selectLine(page, 0)
  await paste(page, 'https://example.com/docs')
  await expect(line(page, 0)).toHaveText('[See the docs](https://example.com/docs)')

  // A lone URL: as copied by default.
  await line(page, 1).click()
  await page.keyboard.press('End')
  await paste(page, 'https://a.example')
  await expect(line(page, 1)).toHaveText('link: https://a.example')

  await changeEditorSettingsElsewhere(page, { pasteUrl: 'autolink' })
  await page.keyboard.press('Shift+Home')
  await paste(page, 'link: ')
  await paste(page, 'https://b.example')
  await expect(line(page, 1)).toHaveText('link: <https://b.example>')

  // As an empty link, the cursor in its text.
  await changeEditorSettingsElsewhere(page, { pasteUrl: 'link' })
  await page.keyboard.press('Shift+Home')
  await paste(page, 'link: ')
  await paste(page, 'https://c.example')
  await page.keyboard.insertText('C')
  await expect(line(page, 1)).toHaveText('link: [C](https://c.example)')
})
