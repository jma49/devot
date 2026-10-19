// Keyboard navigation: Back and Forward through the notes opened, the
// next and previous note in the list, Return and Cmd+Return in the list, Tab
// between the sidebar, the list and the editor, the arrow keys in the
// sidebar, and hiding the sidebar. Window shortcuts are pressed with Meta (the
// registry's Mod matches metaKey on every platform); editor keys are
// platform-neutral, and the caret is placed by typing and clicking only.
import type { Page } from '@playwright/test'
import {
  expect,
  pickMenuItem,
  reloadApp,
  test,
  type TestWindow,
  pickNoteMore,
  pickStatus,
} from './fixtures'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const noteRows = (page: Page) => list(page).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const caption = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.caption')
const backButton = (page: Page) => page.getByRole('button', { name: 'Back', exact: true })
const forwardButton = (page: Page) => page.getByRole('button', { name: 'Forward', exact: true })
const source = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const modeButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const bookRow = (page: Page, name: string) => book(page, name).locator('> .book-row')

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

/** Alpha, Beta, Gamma, opened in that order; the list shows them newest first. */
async function threeNotes(page: Page) {
  for (const title of ['Alpha', 'Beta', 'Gamma']) await createNote(page, title)
  await expect(noteRows(page)).toHaveText([/^Gamma/, /^Beta/, /^Alpha/])
}

/** Types into the open note's body, leaving the caret there. */
async function typeBody(page: Page, text: string) {
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect(body(page)).toBeFocused()
}

const ipcCalls = (page: Page, cmd: string) =>
  page.evaluate(
    (name) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((c) => c.cmd === name)
        .map((c) => c.args),
    cmd,
  )

/**
 * Presses a window shortcut twice in one go: the second press comes before
 * the note the first one opens has loaded (the window has not re-rendered).
 */
const pressTwiceAtOnce = (page: Page, code: 'BracketLeft' | 'BracketRight', shift = false) =>
  page.evaluate(
    (press) => {
      const w = globalThis as unknown as {
        document: { activeElement: unknown; body: { dispatchEvent(e: unknown): void } }
        KeyboardEvent: new (type: string, init: Record<string, unknown>) => unknown
      }
      const { code: keyCode, shift: shiftKey } = press
      const key = { BracketLeft: shiftKey ? '{' : '[', BracketRight: shiftKey ? '}' : ']' }[keyCode]
      const init = { key, code: keyCode, metaKey: true, shiftKey, bubbles: true, cancelable: true }
      const target = (w.document.activeElement ?? w.document.body) as {
        dispatchEvent(e: unknown): void
      }
      target.dispatchEvent(new w.KeyboardEvent('keydown', init))
      target.dispatchEvent(new w.KeyboardEvent('keydown', init))
    },
    { code, shift },
  )

/** View > Hide Sidebar picked in the menu bar (the page gets it as this event). */
const pickViewHideSidebar = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (type: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:toggle-sidebar'))
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test.describe('Back and Forward', () => {
  test('Cmd+[ and Cmd+] go through the notes opened, from the editor too', async ({ page }) => {
    await expect(backButton(page)).toBeDisabled()
    await expect(forwardButton(page)).toBeDisabled()
    await threeNotes(page)
    await expect(backButton(page)).toHaveAttribute('title', 'Back (⌘[)')
    await expect(backButton(page)).toBeEnabled()
    await expect(forwardButton(page)).toBeDisabled()

    // In the editor they go back too (Tab and Shift+Tab indent there), and
    // the keyboard stays in the editor of the note opened.
    await typeBody(page, 'gamma text')
    await page.keyboard.press('Meta+BracketLeft')
    await expect(titleField(page)).toHaveValue('Beta')
    await expect(body(page)).toBeFocused()
    await page.keyboard.press('Meta+BracketRight')
    await expect(titleField(page)).toHaveValue('Gamma')

    // From the note list they go back and forward.
    await noteRow(page, 'Gamma').focus()
    await page.keyboard.press('Meta+BracketLeft')
    await expect(titleField(page)).toHaveValue('Beta')
    await expect(forwardButton(page)).toBeEnabled()
    await page.keyboard.press('Meta+BracketRight')
    await expect(titleField(page)).toHaveValue('Gamma')
    await expect(forwardButton(page)).toBeDisabled()

    // The toolbar buttons do the same, and stop at either end.
    await backButton(page).click()
    await expect(titleField(page)).toHaveValue('Beta')
    await backButton(page).click()
    await expect(titleField(page)).toHaveValue('Alpha')
    await expect(backButton(page)).toBeDisabled()
    await page.keyboard.press('Meta+BracketLeft')
    await expect(titleField(page)).toHaveValue('Alpha')
    await forwardButton(page).click()
    await expect(titleField(page)).toHaveValue('Beta')

    // Opening another note after going back drops the notes ahead.
    await noteRow(page, 'Alpha').click()
    await expect(titleField(page)).toHaveValue('Alpha')
    await expect(forwardButton(page)).toBeDisabled()
    await page.keyboard.press('Meta+BracketLeft')
    await expect(titleField(page)).toHaveValue('Beta')
  })

  test('Tab and Shift+Tab indent and outdent a list item in the editor', async ({ page }) => {
    await threeNotes(page)
    await typeBody(page, '- one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('two')
    await page.keyboard.press('Tab')
    await expect.poll(() => lines(page)).toEqual(['- one', '  - two'])
    await expect(body(page)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => lines(page)).toEqual(['- one', '- two'])
    // Cmd+Left still moves the caret in the text, not back.
    await page.keyboard.press('Meta+ArrowLeft')
    await expect(titleField(page)).toHaveValue('Gamma')
  })

  test('quick presses each go one note further', async ({ page }) => {
    await threeNotes(page)
    await pressTwiceAtOnce(page, 'BracketLeft')
    await expect(titleField(page)).toHaveValue('Alpha')
    await expect(backButton(page)).toBeDisabled()
    await pressTwiceAtOnce(page, 'BracketRight')
    await expect(titleField(page)).toHaveValue('Gamma')
    await expect(forwardButton(page)).toBeDisabled()
  })

  test('quick presses from the Trash each go one note further', async ({ page }) => {
    await threeNotes(page)
    // The Trash shows no open note: the first Back opens the newest entry.
    await source(page, 'Trash').click()
    await expect(header(page)).toHaveText('Trash')
    await pressTwiceAtOnce(page, 'BracketLeft')
    await expect(header(page)).toHaveText('All Notes')
    await expect(titleField(page)).toHaveValue('Beta')
  })

  test('skips notes moved to the Trash, and leaves the Trash', async ({ page }) => {
    await threeNotes(page)
    // Beta goes to the Trash from its context menu; Gamma stays open.
    const popups = () => ipcCalls(page, 'plugin:menu|popup').then((calls) => calls.length)
    await noteRow(page, 'Beta').click({ button: 'right' })
    await expect.poll(popups).toBe(1)
    await pickMenuItem(page, 'Move to Trash')
    await expect(noteRows(page)).toHaveCount(2)
    await expect(titleField(page)).toHaveValue('Gamma')
    await page.keyboard.press('Meta+BracketLeft')
    await expect(titleField(page)).toHaveValue('Alpha')
    await expect(backButton(page)).toBeDisabled()

    // From the Trash, Back opens the last note opened there.
    await source(page, 'Trash').click()
    await expect(header(page)).toHaveText('Trash')
    await expect(backButton(page)).toBeEnabled()
    await backButton(page).click()
    await expect(header(page)).toHaveText('All Notes')
    await expect(titleField(page)).toHaveValue('Alpha')
  })
})

test('Shift+Cmd+] and Shift+Cmd+[ open the next and previous note in the list', async ({
  page,
}) => {
  await threeNotes(page)
  // From the editor: the next note's editor takes the keyboard.
  await typeBody(page, 'g')
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect(titleField(page)).toHaveValue('Beta')
  await expect(body(page)).toBeFocused()
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect(titleField(page)).toHaveValue('Alpha')
  // The last note: nothing after it.
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect(titleField(page)).toHaveValue('Alpha')
  await page.keyboard.press('Meta+Shift+BracketLeft')
  await expect(titleField(page)).toHaveValue('Beta')

  // Quick presses each go one note further.
  await noteRow(page, 'Gamma').click()
  await expect(titleField(page)).toHaveValue('Gamma')
  await pressTwiceAtOnce(page, 'BracketRight', true)
  await expect(titleField(page)).toHaveValue('Alpha')
  await pressTwiceAtOnce(page, 'BracketLeft', true)
  await expect(titleField(page)).toHaveValue('Gamma')

  // From the list: the row follows and keeps the keyboard.
  await noteRow(page, 'Gamma').click()
  await expect(noteRow(page, 'Gamma')).toBeFocused()
  await expect(titleField(page)).toHaveValue('Gamma')
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect(titleField(page)).toHaveValue('Beta')
  await expect(noteRow(page, 'Beta')).toBeFocused()
  await expect(noteRow(page, 'Beta')).toHaveAttribute('aria-selected', 'true')
  // And they are Back and Forward entries like any note opened.
  await page.keyboard.press('Meta+BracketLeft')
  await expect(titleField(page)).toHaveValue('Gamma')
})

test('Return on a row edits the title, Cmd+Return the body', async ({ page }) => {
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await noteRow(page, 'Alpha').click()
  await expect(noteRow(page, 'Alpha')).toBeFocused()
  await expect(titleField(page)).toHaveValue('Alpha')
  await page.keyboard.press('Enter')
  await expect(titleField(page)).toBeFocused()
  await expect(titleField(page)).toHaveValue('Alpha')
  await page.keyboard.insertText(' one')
  await expect(titleField(page)).toHaveValue('Alpha one')

  await noteRow(page, 'Beta').click()
  await expect(noteRow(page, 'Beta')).toBeFocused()
  await expect(titleField(page)).toHaveValue('Beta')
  await page.keyboard.press('Meta+Enter')
  await expect(body(page)).toBeFocused()
  await page.keyboard.insertText('beta text')
  await expect.poll(() => lines(page)).toEqual(['beta text'])

  // A row with no note open yet opens it first. In preview mode Cmd+Return
  // shows the editor. (The window starts with no note open: it forgets where
  // it was.)
  await page.addInitScript(() => localStorage.removeItem('devot.lastState.main'))
  await reloadApp(page)
  await expect(titleField(page)).toBeHidden()
  await noteRow(page, 'Beta').focus()
  await page.keyboard.press('Enter')
  await expect(titleField(page)).toBeFocused()
  await expect(titleField(page)).toHaveValue('Beta')
  await modeButton(page, 'Preview').click()
  await expect(body(page)).toBeHidden()
  await noteRow(page, 'Alpha one').click()
  await expect(titleField(page)).toHaveValue('Alpha one')
  await page.keyboard.press('Meta+Enter')
  await expect(body(page)).toBeFocused()
  await expect(modeButton(page, 'Edit')).toHaveAttribute('aria-pressed', 'true')
})

test.describe('Tab between the areas', () => {
  test('Tab and Shift+Tab move between the sidebar, the list and the editor', async ({ page }) => {
    await createNote(page, 'Alpha')
    const allNotes = source(page, 'All Notes')
    await allNotes.click()
    await expect(allNotes).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(body(page)).toBeFocused()
    // In the editor Tab indents, and Shift+Tab takes it back.
    await page.keyboard.insertText('- item')
    await page.keyboard.press('Tab')
    await expect.poll(() => lines(page)).toEqual(['  - item'])
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => lines(page)).toEqual(['- item'])
    await expect(body(page)).toBeFocused()
    // Escape, then Shift+Tab, leaves the editor for the list.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Tab')
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(allNotes).toBeFocused()
    // Round the window: before the sidebar comes the editor.
    await page.keyboard.press('Shift+Tab')
    await expect(body(page)).toBeFocused()
    await expect.poll(() => lines(page)).toEqual(['- item'])
  })

  test('Control+Tab and Control+Shift+Tab move from anywhere, the editor too', async ({ page }) => {
    await createNote(page, 'Alpha')
    await typeBody(page, 'text')
    await page.keyboard.press('Control+Tab')
    await expect(source(page, 'All Notes')).toBeFocused()
    await page.keyboard.press('Control+Tab')
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('Control+Tab')
    await expect(body(page)).toBeFocused()
    await page.keyboard.press('Control+Shift+Tab')
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    // From the title field (part of the editor area) to the sidebar.
    await titleField(page).click()
    await page.keyboard.press('Control+Tab')
    await expect(source(page, 'All Notes')).toBeFocused()
    await expect.poll(() => lines(page)).toEqual(['text'])
    // With the sidebar hidden, the list and the editor take turns.
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeHidden()
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(body(page)).toBeFocused()
    await page.keyboard.press('Control+Tab')
    await expect(noteRow(page, 'Alpha')).toBeFocused()
  })

  test('a table keeps Tab for its cells', async ({ page }) => {
    await createNote(page, 'Table')
    await typeBody(page, '| a | b |\n|---|---|\n| 1 | 2 |')
    await page.keyboard.press('Tab')
    await expect
      .poll(() => lines(page))
      .toEqual(['| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     |     |'])
    await expect(body(page)).toBeFocused()
  })
})

test('the arrow keys move through the sidebar, and the selection follows', async ({ page }) => {
  // A pinned note in Work > Devot with a status and a tag, and Home.
  for (const name of ['Home', 'Work', 'Devot']) {
    await page.getByRole('button', { name: 'New Notebook' }).click()
    const field = page.getByRole('textbox', { name: 'Notebook name' })
    await field.fill(name)
    await field.press('Enter')
    await expect(book(page, name)).toBeVisible()
  }
  await bookRow(page, 'Devot').dragTo(bookRow(page, 'Work'))
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '2')
  await source(page, 'All Notes').click()
  await createNote(page, 'Plan')
  await pickStatus(page, 'Active')
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('idea')
  await tagField.press('Enter')
  await expect(source(page, 'idea')).toBeVisible()
  await pickNoteMore(page, 'Pin to Top')

  // One tab stop among the rows (the view shown); the resize edge is a stop of
  // its own, for resizing from the keyboard.
  const stops = sidebar(page).locator('[tabindex="0"]:not(.sidebar-resize)')
  await expect(stops).toHaveCount(1)
  await source(page, 'All Notes').click()
  await expect(stops).toHaveText(/^All Notes/)

  const expectAt = async (focused: ReturnType<typeof source>, title: string) => {
    await expect(focused).toBeFocused()
    await expect(header(page)).toHaveText(title)
    await expect(stops).toHaveCount(1)
    await expect(focused).toHaveAttribute('tabindex', '0')
  }
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'Pinned'), 'Pinned')
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'Templates'), 'Templates')
  await page.keyboard.press('ArrowDown')
  await expectAt(book(page, 'Home'), 'Home')
  // A notebook shown leaves the filter.
  await expect(source(page, 'Pinned')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ArrowDown')
  await expectAt(book(page, 'Work'), 'Work')
  // Left closes a notebook, Right opens it, and Right again goes inside.
  await page.keyboard.press('ArrowLeft')
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'false')
  await expect(book(page, 'Devot')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expectAt(book(page, 'Devot'), 'Devot')
  await page.keyboard.press('ArrowLeft')
  await expectAt(book(page, 'Work'), 'Work')
  await page.keyboard.press('ArrowDown')
  await expectAt(book(page, 'Devot'), 'Devot')
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'Active'), 'Active')
  // A filter narrows the notebook shown, as when it is clicked.
  await expect(caption(page)).toHaveText(/^Devot \u00b7 0 notes$/)
  for (const status of ['On Hold', 'Completed', 'Dropped']) {
    await page.keyboard.press('ArrowDown')
    await expectAt(source(page, status), status)
  }
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'idea'), 'idea')
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'Trash'), 'Trash')
  await page.keyboard.press('ArrowDown')
  await expectAt(source(page, 'Trash'), 'Trash')
  await page.keyboard.press('ArrowUp')
  await expectAt(source(page, 'idea'), 'idea')
  await page.keyboard.press('Home')
  await expectAt(source(page, 'All Notes'), 'All Notes')
  await expect(noteRows(page)).toHaveText([/^Plan/])
  await page.keyboard.press('End')
  await expectAt(source(page, 'Trash'), 'Trash')
})

test('arrowing out of the Trash shows All Notes without the filter left behind', async ({
  page,
}) => {
  await createNote(page, 'Plan')
  await pickStatus(page, 'Active')
  await source(page, 'Active').click()
  await expect(header(page)).toHaveText('Active')
  await page.keyboard.press('End')
  await expect(source(page, 'Trash')).toBeFocused()
  await expect(header(page)).toHaveText('Trash')
  await page.keyboard.press('Home')
  await expect(source(page, 'All Notes')).toBeFocused()
  await expect(header(page)).toHaveText('All Notes')
  await expect(source(page, 'Active')).toHaveAttribute('aria-pressed', 'false')
  await expect(source(page, 'All Notes')).toHaveAttribute('tabindex', '0')
})

test('Sort Notes\u2026 in the palette opens the list\u2019s sort pop-up', async ({ page }) => {
  const popups = () =>
    page.evaluate(
      () =>
        (globalThis as unknown as TestWindow).devotIpcCalls.filter(
          (c) => c.cmd === 'plugin:menu|popup',
        ).length,
    )
  await createNote(page, 'Alpha')
  await page.keyboard.press('Meta+KeyK')
  const field = page.getByRole('combobox', { name: 'Command Palette' })
  await field.fill('Sort Notes')
  await field.press('Enter')
  await expect.poll(popups).toBe(1)
})

test.describe('the sidebar', () => {
  test('one toggle at the start of the list header hides and shows it', async ({ page }) => {
    const bar = page.getByRole('region', { name: 'Notes' }).getByRole('toolbar')
    await expect(sidebar(page).getByRole('button', { name: 'Hide Sidebar' })).toHaveCount(0)
    const toggle = bar.getByRole('button', { name: 'Hide Sidebar' })
    await expect(toggle).toHaveAttribute('title', 'Hide Sidebar (⌘/)')
    await expect(bar.getByRole('button').first()).toHaveAccessibleName('Hide Sidebar')
    // Its controls are never part of the window's drag region around them,
    // which would take the press for a window drag.
    for (const button of await bar.getByRole('button').all())
      await expect(button).toHaveAttribute('data-tauri-drag-region', 'false')
    const inset = bar.locator('.window-inset')
    await expect.poll(async () => (await inset.boundingBox())?.width).toBe(0)

    await toggle.click()
    await expect(sidebar(page)).toBeHidden()
    // The window controls get their room before the toggle: it starts 84 px
    // in, clear of them, where the editor's header starts in focus mode.
    const show = bar.getByRole('button', { name: 'Show Sidebar' })
    await expect.poll(async () => (await show.boundingBox())?.x).toBe(84)
    await show.click()
    await expect(sidebar(page)).toBeVisible()
    await expect.poll(async () => (await inset.boundingBox())?.width).toBe(0)
    await expect(bar.getByRole('button', { name: 'Hide Sidebar' })).toBeVisible()
  })

  test('Cmd+/ hides and shows it, from the editor too, and the window remembers it', async ({
    page,
  }) => {
    await createNote(page, 'Alpha')
    await typeBody(page, 'text')
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeHidden()
    await expect(body(page)).toBeFocused()
    await expect.poll(() => lines(page)).toEqual(['text'])
    await expect.poll(() => ipcCalls(page, 'sidebar_menu_set')).toContainEqual({ shown: false })
    const show = page.getByRole('button', { name: 'Show Sidebar' })
    await expect(show).toHaveAttribute('title', 'Show Sidebar (⌘/)')

    await reloadApp(page)
    await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible()
    await expect(sidebar(page)).toBeHidden()
    await expect
      .poll(async () => (await ipcCalls(page, 'sidebar_menu_set')).at(-1))
      .toEqual({
        shown: false,
      })

    await show.click()
    await expect(sidebar(page)).toBeVisible()
    await expect.poll(() => ipcCalls(page, 'sidebar_menu_set')).toContainEqual({ shown: true })
    await page.getByRole('button', { name: 'Hide Sidebar' }).click()
    await expect(sidebar(page)).toBeHidden()
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeVisible()
    await reloadApp(page)
    await expect(sidebar(page)).toBeVisible()
  })

  test('a held Cmd+/ toggles once, and its repeats go nowhere else', async ({ page }) => {
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        addEventListener(type: string, listener: (e: unknown) => void): void
        devotRepeats: boolean[]
      }
      w.devotRepeats = []
      w.addEventListener('keydown', (e) => {
        const key = e as { repeat: boolean; defaultPrevented: boolean }
        if (key.repeat) w.devotRepeats.push(key.defaultPrevented)
      })
    })
    await page.keyboard.down('Meta')
    // One press and one repeat: a repeat that ran the command too would
    // show the sidebar again.
    await page.keyboard.down('Slash')
    await page.keyboard.down('Slash')
    await page.keyboard.up('Slash')
    await page.keyboard.up('Meta')
    await expect(sidebar(page)).toBeHidden()
    // The repeats were stopped, so a native menu item never sees them.
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { devotRepeats: boolean[] }).devotRepeats,
      ),
    ).toEqual([true])
  })

  test('the same Cmd+/ reaching the menu bar too is dropped once', async ({ page }) => {
    // The key, then at once the menu item with that key, as if the menu bar
    // had seen the same press.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        document: { body: { dispatchEvent(e: unknown): void } }
        dispatchEvent(e: unknown): void
        CustomEvent: new (type: string) => unknown
        KeyboardEvent: new (type: string, init: Record<string, unknown>) => unknown
      }
      const init = { key: '/', code: 'Slash', metaKey: true, bubbles: true, cancelable: true }
      w.document.body.dispatchEvent(new w.KeyboardEvent('keydown', init))
      w.dispatchEvent(new w.CustomEvent('devot:toggle-sidebar'))
    })
    await expect(sidebar(page)).toBeHidden()
    // A later pick is the user's own.
    await pickViewHideSidebar(page)
    await expect(sidebar(page)).toBeVisible()
  })

  test('the Show Sidebar button gives the keyboard to the sidebar', async ({ page }) => {
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeHidden()
    await page.getByRole('button', { name: 'Show Sidebar' }).focus()
    await page.keyboard.press('Enter')
    await expect(sidebar(page)).toBeVisible()
    await expect(source(page, 'All Notes')).toBeFocused()
  })

  test('View > Hide Sidebar in the menu bar hides and shows it', async ({ page }) => {
    await expect(sidebar(page)).toBeVisible()
    await pickViewHideSidebar(page)
    await expect(sidebar(page)).toBeHidden()
    await pickViewHideSidebar(page)
    await expect(sidebar(page)).toBeVisible()
  })

  test('hiding it moves the keyboard to the list; in focus mode Cmd+/ shows it', async ({
    page,
  }) => {
    await createNote(page, 'Alpha')
    await source(page, 'All Notes').click()
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeHidden()
    await expect(noteRow(page, 'Alpha')).toBeFocused()
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeVisible()

    await page.keyboard.press('Meta+Shift+KeyD')
    await expect(sidebar(page)).toBeHidden()
    await expect.poll(() => ipcCalls(page, 'sidebar_menu_set')).toContainEqual({ shown: false })
    await page.keyboard.press('Meta+Slash')
    await expect(sidebar(page)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
