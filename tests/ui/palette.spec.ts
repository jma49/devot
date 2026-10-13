import type { Page } from '@playwright/test'
import { expect, test, pickNoteMore, openNotePinned, statusPicker, bookPicker } from './fixtures'

// App-level shortcuts check metaKey (Command on macOS), so they are pressed
// with Meta here on every platform, like the other specs.

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })
const results = (page: Page) => palette(page).getByRole('listbox', { name: 'Results' })
const group = (page: Page, name: string) => results(page).getByRole('group', { name })
const options = (page: Page) => results(page).getByRole('option')
const active = (page: Page) => results(page).locator('[role="option"][aria-selected="true"]')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const noteTags = (page: Page) => page.getByRole('group', { name: 'Tags' })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const nameField = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(nameField).toBeFocused()
  await nameField.fill(name)
  await nameField.press('Enter')
  await expect(tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
}

async function addTag(page: Page, name: string) {
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill(name)
  await tagField.press('Enter')
  await expect(noteTags(page).getByText(name, { exact: true })).toBeVisible()
}

/** What View > Command Palette\u2026 in the menu bar sends to the page. */
const showFromMenu = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (type: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-palette'))
  })

/** Opens the palette with Cmd+P and types a query. */
async function search(page: Page, query: string) {
  await page.keyboard.press('Meta+KeyP')
  await expect(field(page)).toBeFocused()
  await field(page).fill(query)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('lists commands with their shortcuts and runs the one picked', async ({ page }) => {
  await createNote(page, 'Draft')
  await noteRows(page).first().click()
  await search(page, '')
  // Nothing typed: the sources, each with its key.
  await expect(options(page)).toHaveText([
    /Search and run commands\s*>/,
    /Search notebooks\s*b/,
    /Search tags\s*t/,
    /Outline of this note\s*#/,
    /Search notes/,
  ])
  // Commands scope: every command the window can run.
  await field(page).fill('> ')
  const commands = group(page, 'Commands')
  await expect(commands.getByRole('option').filter({ hasText: 'Focus Mode' })).toContainText(
    '\u21e7\u2318D',
  )
  await expect(commands.getByRole('option').filter({ hasText: 'Duplicate' })).toContainText(
    '\u2318D',
  )
  await expect(commands.getByRole('option').filter({ hasText: 'Pin to Top' })).toBeVisible()
  // The palette never lists itself.
  await expect(commands.getByRole('option').filter({ hasText: 'Command Palette' })).toHaveCount(0)

  await field(page).fill('focmo')
  await expect(active(page)).toContainText('Focus Mode')
  await expect(active(page).locator('mark')).toHaveText(['Foc', 'Mo'])
  await expect(field(page)).toHaveAttribute(
    'aria-activedescendant',
    (await active(page).getAttribute('id')) ?? '',
  )
  await field(page).press('Enter')
  await expect(palette(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('labels a command for the open note: Pin to Top or Unpin', async ({ page }) => {
  await createNote(page, 'Pinned one')
  await search(page, 'pin')
  await expect(active(page)).toContainText('Pin to Top')
  await field(page).press('Enter')
  await expect.poll(() => openNotePinned(page)).toBe(true)
  await search(page, 'unpin')
  await expect(active(page)).toContainText('Unpin')
})

test('Cmd+K opens it outside the editor; in the editor Cmd+K stays Link', async ({ page }) => {
  await createNote(page, 'Keys')
  await body(page).click()
  await page.keyboard.insertText('word')
  await noteRows(page).first().click()
  await page.keyboard.press('Meta+KeyK')
  await expect(field(page)).toBeFocused()
  // Escape closes it and gives the keyboard back to the list.
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
  await expect(noteRows(page).first()).toBeFocused()

  await body(page).dblclick()
  await page.keyboard.press('ControlOrMeta+KeyK')
  await expect(body(page)).toHaveText('[word]()')
  await expect(palette(page)).toBeHidden()
  // Cmd+P works in the editor too, and Escape puts the keyboard back there.
  await page.keyboard.press('Meta+KeyP')
  await expect(field(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.insertText('!')
  await expect(body(page)).toContainText('!')
})

test('runs a format on the editor selection', async ({ page }) => {
  await createNote(page, 'Formats')
  await body(page).click()
  await page.keyboard.insertText('loud')
  await body(page).dblclick()
  await search(page, 'bold')
  await expect(active(page)).toContainText('Bold')
  await expect(active(page)).toContainText('\u2318B')
  await field(page).press('Enter')
  await expect(body(page)).toHaveText('**loud**')
})

test('block formats and alerts are commands while the editor shows', async ({ page }) => {
  await createNote(page, 'Blocks')
  await body(page).click()
  await page.keyboard.insertText('idea')
  await body(page).dblclick()
  await search(page, 'code block')
  await expect(active(page)).toContainText('Code Block')
  await expect(active(page)).toContainText('\u21e7\u2318C')
  await search(page, 'warning alert')
  await expect(active(page)).toContainText('Warning Alert')
  await field(page).press('Enter')
  await expect(body(page)).toContainText('> [!WARNING]')
  await expect(body(page)).toBeFocused()
  // In preview mode there is no editor to format.
  await search(page, 'show preview')
  await field(page).press('Enter')
  await search(page, 'alert')
  const commands = group(page, 'Commands')
  await expect(commands.getByRole('option').filter({ hasText: 'Alert' })).toHaveCount(0)
  await search(page, 'bulleted list')
  await expect(commands.getByRole('option').filter({ hasText: 'Bulleted List' })).toHaveCount(0)
})

test('find and the status keys are commands while a note is open', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  const commands = group(page, 'Commands')
  const command = (name: string) => commands.getByRole('option').filter({ hasText: name })
  await search(page, 'find in note')
  await expect(command('Find in Note')).toHaveCount(0)
  await search(page, 'set status')
  await expect(command('Set Status to Active')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await createNote(page, 'Findable')
  await body(page).click()
  await page.keyboard.insertText('alpha Alpha')
  await search(page, 'set status to active')
  await expect(active(page)).toContainText('Set Status to Active')
  await expect(active(page)).toContainText('\u2303\u23182')
  await field(page).press('Enter')
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'active')

  // Match Case only acts while the find bar is open.
  await search(page, 'match case')
  await expect(command('Match Case')).toHaveCount(0)
  await search(page, 'find in note')
  await expect(active(page)).toContainText('Find in Note')
  await expect(active(page)).toContainText('\u2318F')
  await field(page).press('Enter')
  const bar = page.getByRole('search', { name: 'Find in Note' })
  const findField = bar.getByRole('textbox', { name: 'Find' })
  await expect(findField).toBeFocused()
  await page.keyboard.type('alpha')
  await expect(bar.getByRole('status')).toHaveText('1 of 2')
  await search(page, 'match case')
  await expect(active(page)).toContainText('Match Case')
  await field(page).press('Enter')
  await expect(bar.getByRole('button', { name: 'Match Case', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(bar.getByRole('status')).toHaveText('1 of 1')
})

test('notebooks: Return opens one, Shift+Return moves the open note there', async ({ page }) => {
  await createBook(page, 'Recipes')
  await createBook(page, 'Work')
  await sidebar(page)
    .getByRole('button', { name: /All Notes/ })
    .click()
  await createNote(page, 'Soup')

  await search(page, 'recip')
  await expect(group(page, 'Notebooks').getByRole('option')).toHaveText(['Recipes'])
  await expect(palette(page).locator('#palette-keys')).toContainText('Open Notebook')
  await field(page).press('Shift')
  await expect(palette(page).locator('#palette-keys')).toContainText('Move Note to Notebook')
  await field(page).press('Shift+Enter')
  await expect(palette(page)).toBeHidden()
  await expect(bookPicker(page)).toHaveAttribute('data-value', /.+/)
  await expect(bookPicker(page).locator('.popup-value')).toHaveText(/Recipes/)
  // The note is in that notebook now: it is not offered there again.
  await search(page, 'recip')
  await expect(palette(page).locator('#palette-keys')).not.toContainText('Open Notebook')
  await field(page).press('Enter')
  await expect(header(page)).toHaveText('Recipes')
  await expect(noteRows(page)).toHaveText([/Soup/])
})

test('tags: Return filters by one, Shift+Return adds it to the open note', async ({ page }) => {
  await createNote(page, 'Tagged')
  await addTag(page, 'urgent')
  await createNote(page, 'Plain')

  await search(page, 'urg')
  await expect(group(page, 'Tags').getByRole('option')).toHaveText(['urgent'])
  await field(page).press('Shift+Enter')
  await expect(palette(page)).toBeHidden()
  await expect(noteTags(page).getByText('urgent', { exact: true })).toBeVisible()

  await search(page, 'urg')
  await field(page).press('Enter')
  await expect(header(page)).toHaveText('urgent')
  await expect(sidebar(page).getByRole('button', { name: /^urgent 2$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('notes: a title found by its letters opens with Return or a click', async ({ page }) => {
  await createNote(page, 'Alpha plan')
  await createNote(page, 'Beta')
  await search(page, 'alpl')
  const notes = group(page, 'Notes').getByRole('option')
  await expect(notes).toHaveText(['Alpha plan'])
  await expect(notes.locator('mark')).toHaveText(['Al', 'pl'])
  await field(page).press('Enter')
  await expect(titleField(page)).toHaveValue('Alpha plan')

  await search(page, 'beta')
  await group(page, 'Notes').getByRole('option', { name: 'Beta' }).click()
  await expect(palette(page)).toBeHidden()
  await expect(titleField(page)).toHaveValue('Beta')
})

test('notes open from the Trash view too', async ({ page }) => {
  await createNote(page, 'Live')
  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await expect(header(page)).toHaveText('Trash')
  await search(page, 'live')
  await field(page).press('Enter')
  await expect(header(page)).toHaveText('All Notes')
  await expect(titleField(page)).toHaveValue('Live')
})

test('groups results by kind, best match first, and moves by arrow keys', async ({ page }) => {
  await createBook(page, 'Notes archive')
  await createNote(page, 'Work notes')
  await addTag(page, 'work')
  await search(page, 'work')
  await expect(results(page).getByRole('group')).toHaveCount(2)
  // Equally good matches keep the kind order: tags before notes.
  await expect(results(page).getByRole('group').first()).toHaveAttribute('aria-label', 'Tags')
  await expect(active(page)).toHaveText('work')
  await field(page).press('ArrowDown')
  await expect(active(page)).toContainText('Work notes')
  // The note shows its notebook.
  await expect(active(page).locator('.palette-detail')).toHaveText('Notes archive')
  await field(page).press('ArrowDown')
  await expect(active(page)).toContainText('Work notes')
  await field(page).press('ArrowUp')
  await expect(active(page)).toHaveText('work')

  await field(page).fill('zzzz')
  await expect(options(page)).toHaveCount(0)
  await expect(palette(page)).toContainText('No results.')
})

test('the View menu item opens it, but not over another sheet', async ({ page }) => {
  await createNote(page, 'Menu')
  await showFromMenu(page)
  await expect(field(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()

  await pickNoteMore(page, 'Revision History\u2026')
  await expect(page.getByRole('dialog', { name: 'Revision History' })).toBeVisible()
  await page.keyboard.press('Meta+KeyP')
  await showFromMenu(page)
  await expect(palette(page)).toBeHidden()
})

test('a menu item picked while another window has the keyboard acts on nothing here', async ({
  page,
}) => {
  await createNote(page, 'Menu')
  // The Settings window, or a native panel, is the one the user is in: Rust
  // still sends the menu item's event to this window.
  const focus = (windowHasFocus: boolean) =>
    page.evaluate((on) => {
      ;(globalThis as unknown as { document: { hasFocus(): boolean } }).document.hasFocus = () => on
    }, windowHasFocus)
  await focus(false)
  await showFromMenu(page)
  await page.waitForTimeout(150)
  await expect(palette(page)).toBeHidden()
  await focus(true)
  await showFromMenu(page)
  await expect(field(page)).toBeFocused()
})

test('New Note and the search shortcuts are commands too', async ({ page }) => {
  // Cmd+N works once the notes are loaded, like the New Note button.
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.keyboard.press('Meta+KeyN')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(titleField(page)).toHaveValue('')
  await search(page, 'search all')
  await field(page).press('Enter')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeFocused()
})

test('Shift-click runs the Shift variant; a modifier without one does nothing', async ({
  page,
}) => {
  await createBook(page, 'Archive')
  await sidebar(page)
    .getByRole('button', { name: /All Notes/ })
    .click()
  await createNote(page, 'Old plan')
  await search(page, 'archive')
  await group(page, 'Notebooks')
    .getByRole('option')
    .click({ modifiers: ['Shift'] })
  await expect(palette(page)).toBeHidden()
  await expect(bookPicker(page).locator('.popup-value')).toHaveText(/Archive/)
  // A command has no Shift variant: Shift+Return does nothing.
  await search(page, 'focus mode')
  await field(page).press('Shift+Enter')
  await expect(palette(page)).toBeVisible()
  await field(page).press('Enter')
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('Return that ends an input method composition picks nothing', async ({ page }) => {
  await createNote(page, 'Compose')
  await search(page, 'focus')
  await field(page).evaluate((input) => {
    const target = input as unknown as { dispatchEvent(e: unknown): void }
    const Keyboard = (
      globalThis as unknown as { KeyboardEvent: new (t: string, o: object) => unknown }
    ).KeyboardEvent
    target.dispatchEvent(
      new Keyboard('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    )
  })
  await expect(palette(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})

test('a click outside closes it; a click on its own padding does not', async ({ page }) => {
  await createNote(page, 'Clicks')
  await search(page, '')
  const box = await palette(page).boundingBox()
  if (!box) throw new Error('E_TEST_NO_BOX')
  // Between the field and the results, on the palette's own padding.
  await page.mouse.click(box.x + 3, box.y + box.height / 2)
  await expect(palette(page)).toBeVisible()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 40)
  await expect(palette(page)).toBeHidden()
})

test('the keyboard stays in the window when a command hides where it was', async ({ page }) => {
  await createNote(page, 'Hidden')
  await body(page).click()
  await page.keyboard.insertText('text')
  await search(page, 'show preview')
  await field(page).press('Enter')
  await expect(page.getByRole('article', { name: 'Preview' })).toBeVisible()
  await expect(body(page)).toBeHidden()
  // The open note's row takes the keyboard: list keys work at once.
  await expect(noteRows(page).filter({ hasText: 'Hidden' })).toBeFocused()
})

test('a notebook named as typed comes before a command with the letters apart', async ({
  page,
}) => {
  await createBook(page, 'Stash')
  await search(page, 'stash')
  // Show Trash has the letters too, but the notebook is the whole query.
  await expect(group(page, 'Commands').getByRole('option')).toContainText(['Show Trash'])
  await expect(results(page).getByRole('group')).toHaveCount(2)
  await expect(results(page).getByRole('group').first()).toHaveAttribute('aria-label', 'Notebooks')
  await expect(active(page)).toHaveText('Stash')
})

test('Cmd+N in the Trash opens All Notes with the new note', async ({ page }) => {
  await createNote(page, 'Kept')
  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await expect(header(page)).toHaveText('Trash')
  await page.keyboard.press('Meta+KeyN')
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(titleField(page)).toBeVisible()
  await expect(titleField(page)).toHaveValue('')
})

test('opening the open note again keeps its preview', async ({ page }) => {
  await createNote(page, 'Shown')
  await body(page).click()
  await page.keyboard.insertText('hello world')
  await search(page, 'show editor and preview')
  await field(page).press('Enter')
  const preview = page.getByRole('article', { name: 'Preview' })
  await expect(preview).toContainText('hello world')
  await search(page, 'shown')
  await expect(active(page)).toContainText('Shown')
  await field(page).press('Enter')
  await expect(palette(page)).toBeHidden()
  await expect(preview).toContainText('hello world')
})

/** Whether some element other than the page itself has the keyboard. */
const keyboardHeld = (page: Page) =>
  page.evaluate(() => {
    const d = (globalThis as unknown as { document: { activeElement: unknown; body: unknown } })
      .document
    return d.activeElement !== null && d.activeElement !== d.body
  })

test('a note opened from the editor takes the keyboard into its editor', async ({ page }) => {
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await body(page).click()
  await search(page, 'alpha')
  await field(page).press('Enter')
  await expect(titleField(page)).toHaveValue('Alpha')
  await expect(body(page)).toBeFocused()
  await expect.poll(() => keyboardHeld(page)).toBe(true)
  await page.keyboard.insertText('typed')
  await expect(body(page)).toContainText('typed')
})

test('Move to Trash from the editor leaves the keyboard in the list', async ({ page }) => {
  await createNote(page, 'Stays')
  await createNote(page, 'Goes')
  await body(page).click()
  await page.keyboard.insertText('gone soon')
  await search(page, 'move to trash')
  await field(page).press('Enter')
  await expect(noteRows(page)).toHaveText([/Stays/])
  await expect(noteRows(page).first()).toBeFocused()
  await expect.poll(() => keyboardHeld(page)).toBe(true)
  // List keys work at once.
  await page.keyboard.press('Meta+KeyD')
  await expect(noteRows(page)).toHaveCount(2)
})

test('Duplicate from the editor keeps the keyboard in the window', async ({ page }) => {
  await createNote(page, 'Twin')
  await body(page).click()
  await search(page, 'duplicate')
  await field(page).press('Enter')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(body(page)).toBeFocused()
  await expect.poll(() => keyboardHeld(page)).toBe(true)
})

test('runs the Trash commands: Restore, Delete Permanently, Empty Trash', async ({ page }) => {
  const trashButton = sidebar(page).getByRole('button', { name: /^Trash \d+$/ })
  await createNote(page, 'Back')
  await pickNoteMore(page, 'Move to Trash')
  await expect(trashButton).toHaveText(/1$/)
  await createNote(page, 'Gone')
  await pickNoteMore(page, 'Move to Trash')
  await expect(trashButton).toHaveText(/2$/)
  await trashButton.click()
  await expect(noteRows(page)).toHaveCount(2)
  // Nothing open: only Empty Trash is offered.
  await search(page, 'restore from trash')
  await expect(options(page).filter({ hasText: 'Restore from Trash' })).toHaveCount(0)
  await field(page).fill('empty trash')
  await expect(active(page)).toContainText('Empty Trash')
  await page.keyboard.press('Escape')

  await noteRows(page).filter({ hasText: 'Back' }).click()
  await search(page, 'restore from trash')
  await expect(active(page)).toContainText('Restore from Trash')
  await field(page).press('Enter')
  await expect(noteRows(page)).toHaveText([/Gone/])

  await noteRows(page).first().click()
  await search(page, 'delete permanently')
  await field(page).press('Enter')
  const confirm = page.getByRole('dialog').filter({ hasText: 'Permanently delete' })
  await expect(confirm).toContainText('\u201cGone\u201d')
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  // The key comes from the registry too: Cmd+Delete on the row.
  await noteRows(page).first().click()
  await page.keyboard.press('Meta+Backspace')
  await expect(confirm).toContainText('\u201cGone\u201d')
  await confirm.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(0)
})

test('b and a space scope the palette to notebooks; Shift+Return files the open note there', async ({
  page,
}) => {
  await createBook(page, 'Recipes')
  await sidebar(page)
    .getByRole('button', { name: /All Notes/ })
    .click()
  await createNote(page, 'Soup')
  await page.keyboard.press('Meta+KeyP')
  await field(page).fill('b ')
  await expect(field(page)).toHaveAttribute('placeholder', 'Search notebooks...')
  await expect(palette(page).getByRole('button', { name: 'Back' })).toBeVisible()
  await field(page).fill('recip')
  await field(page).press('Shift+Enter')
  await expect(palette(page)).toBeHidden()
  await expect(
    page.getByRole('combobox', { name: 'Notebook' }).locator('option:checked'),
  ).toHaveText(/Recipes/)
})

test('Escape steps back from a query to the scope, to the sources, then closes', async ({
  page,
}) => {
  await page.keyboard.press('Meta+KeyP')
  await field(page).fill('t ur')
  await expect(field(page)).toHaveValue('ur')
  await field(page).press('Escape')
  await expect(field(page)).toHaveValue('')
  await expect(field(page)).toHaveAttribute('placeholder', 'Search tags...')
  await field(page).press('Escape')
  await expect(field(page)).toHaveAttribute('placeholder', /Search commands, notebooks, tags/)
  await field(page).press('Escape')
  await expect(palette(page)).toBeHidden()
})

test('the outline source lists headings and tasks; Return moves the caret there', async ({
  page,
}) => {
  await createNote(page, 'Outlined')
  await body(page).click()
  await page.keyboard.type('# One\n\n- [ ] first task\n\n## Two\n')
  await page.keyboard.press('Meta+KeyP')
  await field(page).fill('# ')
  await expect(options(page)).toHaveText(['One', 'first task', 'Two'])
  await options(page).nth(2).click()
  await expect(palette(page)).toBeHidden()
  await expect(body(page)).toBeFocused()
})
