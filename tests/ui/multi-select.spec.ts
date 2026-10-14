import type { Page } from '@playwright/test'
import { NATIVE_CLIPBOARD_LIMIT } from '../../src/renderer/src/clipboard'
import {
  changeShortcutsElsewhere,
  clipboardWrites,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type TestWindow,
  pickStatus,
  statusPicker,
} from './fixtures'
import { seedNotes } from './renders'

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const noteRows = (page: Page) => list(page).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const summary = (page: Page) => page.getByRole('region', { name: 'Selected Notes' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const book = (page: Page, name: string) =>
  page
    .getByRole('tree', { name: 'Notebooks' })
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const bookRow = (page: Page, name: string) => book(page, name).locator('> .book-row')
const sourceRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })

interface StoredNote {
  id: string
  title: string
  bookId: string | null
  status: string
  statusHlc: string
  pinned: boolean
  pinnedHlc: string
  bookHlc: string
  deletedAt: number | null
}

/** The saved notes by title (the in-memory store; not what is on screen). */
const stored = (page: Page) =>
  page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[]
    return Object.fromEntries(all.map((n) => [n.title, n]))
  })

/** The titles of the tags on each saved note. */
const storedTags = (page: Page) =>
  page.evaluate(() => {
    const read = <T>(key: string) => JSON.parse(localStorage.getItem(key) ?? '[]') as T[]
    const notes = read<{ id: string; title: string }>('devot.test.notes')
    const tags = read<{ id: string; name: string }>('devot.test.tags')
    const links = read<{ noteId: string; tagId: string; present: boolean }>('devot.test.noteTags')
    return Object.fromEntries(
      notes.map((n) => [
        n.title,
        links
          .filter((l) => l.noteId === n.id && l.present)
          .map((l) => tags.find((tag) => tag.id === l.tagId)?.name)
          .sort(),
      ]),
    )
  })

/** The titles of the rows shown as selected, top to bottom. */
const selectedTitles = (page: Page) =>
  list(page).locator('[role="option"][aria-selected="true"] .row-title').allTextContents()

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

/** Four notes, listed newest first: Delta, Gamma, Beta, Alpha. */
async function fourNotes(page: Page) {
  for (const title of ['Alpha', 'Beta', 'Gamma', 'Delta']) await createNote(page, title)
  await expect(noteRows(page).locator('.row-title')).toHaveText(['Delta', 'Gamma', 'Beta', 'Alpha'])
}

/** Opens `first`, then Cmd-clicks each of `more`. */
async function pick(page: Page, first: string, ...more: string[]) {
  await noteRow(page, first).click()
  await expect(titleField(page)).toHaveValue(first)
  for (const title of more) await noteRow(page, title).click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

/** Runs the palette command labelled `label` (Meta+K: the registry key). */
async function runCommand(page: Page, label: string) {
  await page.keyboard.press('Meta+k')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox').fill(label)
  const active = palette.locator('[role="option"][aria-selected="true"] .palette-label')
  await expect(active).toHaveText(new RegExp(`^${label}`))
  await palette.getByRole('combobox').press('Enter')
  await expect(palette).toHaveCount(0)
}

/** Creates templates in the Templates view, titled `titles` in order. */
async function createTemplates(page: Page, ...titles: string[]) {
  await sidebar(page)
    .getByRole('button', { name: /^Templates/ })
    .click()
  for (const title of titles) {
    await page.getByRole('button', { name: 'New Template' }).click()
    await expect(titleField(page)).toHaveValue('')
    await titleField(page).fill(title)
    await expect(noteRow(page, title)).toHaveCount(1)
  }
}

async function openMenu(page: Page, title: string) {
  const before = await popups(page)
  await noteRow(page, title).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Cmd-click and Shift-click select several notes; the editor shows a summary', async ({
  page,
}) => {
  await fourNotes(page)
  await expect(list(page)).toHaveAttribute('aria-multiselectable', 'true')
  await noteRow(page, 'Delta').click()
  await noteRow(page, 'Beta').click({ modifiers: ['Meta'] })
  expect(await selectedTitles(page)).toEqual(['Delta', 'Beta'])
  await expect(summary(page).getByRole('heading')).toHaveText('2 Notes Selected')
  await expect(summary(page).getByRole('listitem')).toHaveText(['Delta', 'Beta'])
  // The open note's editor gives way to the summary.
  await expect(titleField(page)).toHaveCount(0)
  await expect(body(page)).toHaveCount(0)

  // Shift-click: from the row Cmd-clicked last to this one.
  await noteRow(page, 'Alpha').click({ modifiers: ['Shift'] })
  expect(await selectedTitles(page)).toEqual(['Beta', 'Alpha'])
  // Cmd-click takes a row out again; one left is the open note on its own.
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Beta')
  expect(await selectedTitles(page)).toEqual(['Beta'])

  // A plain click selects one row again.
  await noteRow(page, 'Gamma').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
  await noteRow(page, 'Alpha').click()
  await expect(summary(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Alpha')
  expect(await selectedTitles(page)).toEqual(['Alpha'])
})

test('Shift+arrows extend the selection, Cmd+A selects all, Escape goes back to the open note', async ({
  page,
}) => {
  await fourNotes(page)
  await noteRow(page, 'Gamma').click()
  // The selection grows from the open note: wait for the click to open it.
  await expect(titleField(page)).toHaveValue('Gamma')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  expect(await selectedTitles(page)).toEqual(['Gamma', 'Beta', 'Alpha'])
  await expect(noteRow(page, 'Alpha')).toBeFocused()
  await page.keyboard.press('Shift+ArrowUp')
  await page.keyboard.press('Shift+ArrowUp')
  await page.keyboard.press('Shift+ArrowUp')
  expect(await selectedTitles(page)).toEqual(['Delta', 'Gamma'])
  await expect(summary(page).getByRole('heading')).toHaveText('2 Notes Selected')

  await page.keyboard.press('Meta+a')
  expect(await selectedTitles(page)).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha'])
  await expect(summary(page).getByRole('heading')).toHaveText('4 Notes Selected')

  // Escape: back to the note that stayed open.
  await page.keyboard.press('Escape')
  expect(await selectedTitles(page)).toEqual(['Gamma'])
  await expect(titleField(page)).toHaveValue('Gamma')
  await expect(noteRow(page, 'Gamma')).toBeFocused()

  // A plain arrow moves on with one row.
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('ArrowDown')
  expect(await selectedTitles(page)).toEqual(['Alpha'])
  await expect(titleField(page)).toHaveValue('Alpha')

  // In the editor, Select All selects the text, not the notes.
  await body(page).click()
  await page.keyboard.insertText('first words')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('replaced')
  await expect(body(page)).toHaveText('replaced')
  expect(await selectedTitles(page)).toEqual(['Alpha'])
})

test('a held command key does its work once and is stopped, so it never repeats into the menu bar', async ({
  page,
}) => {
  await fourNotes(page)
  await noteRow(page, 'Gamma').click()
  await expect(titleField(page)).toHaveValue('Gamma')
  // What the page's last listener sees of each key: after the list's own.
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      seenKeys: [string, boolean, boolean][]
      addEventListener(
        type: string,
        listener: (e: { key: string; repeat: boolean; defaultPrevented: boolean }) => void,
      ): void
    }
    w.seenKeys = []
    w.addEventListener('keydown', (e) => w.seenKeys.push([e.key, e.repeat, e.defaultPrevented]))
  })
  const seen = () =>
    page.evaluate(() => (globalThis as unknown as { seenKeys: unknown[] }).seenKeys)
  await page.keyboard.down('Meta')
  // Cmd+A selects all notes; held, it is stopped and selects nothing more.
  await page.keyboard.down('a')
  await page.keyboard.down('a')
  await page.keyboard.down('a')
  await page.keyboard.up('a')
  // Cmd+C copies a link; held, it is stopped before it copies over it again.
  await page.keyboard.down('c')
  await page.keyboard.down('c')
  await page.keyboard.up('c')
  await page.keyboard.up('Meta')
  expect(await seen()).toEqual([
    ['Meta', false, false],
    ['a', false, true],
    ['a', true, true],
    ['a', true, true],
    ['c', false, true],
    ['c', true, true],
  ])
  expect(await selectedTitles(page)).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha'])
  await expect.poll(() => clipboardWrites(page)).toHaveLength(1)
})

test('keys set for the selection commands select notes and tag them all', async ({ page }) => {
  await fourNotes(page)
  // What Rust sends after a change in Settings > Keyboard Shortcuts.
  await changeShortcutsElsewhere(page, {
    'list.extendDown': ['Ctrl+Alt+J'],
    'list.extendUp': ['Ctrl+Alt+K'],
    'list.selectAll': ['Ctrl+Alt+A'],
    'list.clearSelection': ['Ctrl+Alt+X'],
    'note.addTag': ['Ctrl+Alt+T'],
    'note.removeTag': ['Ctrl+Alt+R'],
  })
  await noteRow(page, 'Gamma').click()
  await expect(noteRow(page, 'Gamma')).toBeFocused()
  // Add Tag is for several notes: with one, its key does nothing.
  await page.keyboard.press('Control+Alt+KeyT')
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog', { name: 'Add Tag' })).toHaveCount(0)

  await page.keyboard.press('Control+Alt+KeyJ')
  await page.keyboard.press('Control+Alt+KeyJ')
  expect(await selectedTitles(page)).toEqual(['Gamma', 'Beta', 'Alpha'])
  await page.keyboard.press('Control+Alt+KeyK')
  expect(await selectedTitles(page)).toEqual(['Gamma', 'Beta'])
  // Cmd+A is no longer the key; the new one selects every note.
  await page.keyboard.press('Meta+a')
  expect(await selectedTitles(page)).toEqual(['Gamma', 'Beta'])
  await page.keyboard.press('Control+Alt+KeyA')
  expect(await selectedTitles(page)).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha'])
  // The context menu shows the keys in effect.
  await openMenu(page, 'Gamma')
  expect(await shownMenu(page)).toContain('Add Tag to Selected Notes\u2026 Ctrl+Alt+T')

  await noteRow(page, 'Gamma').focus()
  await page.keyboard.press('Control+Alt+KeyT')
  const add = page.getByRole('dialog', { name: 'Add Tag' })
  await add.getByRole('combobox', { name: 'Filter tags' }).fill('later')
  await add.getByRole('combobox', { name: 'Filter tags' }).press('Enter')
  await expect(add).toHaveCount(0)
  await expect
    .poll(() => storedTags(page))
    .toEqual({ Alpha: ['later'], Beta: ['later'], Gamma: ['later'], Delta: ['later'] })
  await noteRow(page, 'Beta').focus()
  await page.keyboard.press('Control+Alt+KeyR')
  await page
    .getByRole('dialog', { name: 'Remove Tag' })
    .getByRole('option', { name: 'later' })
    .click()
  await expect.poll(() => storedTags(page)).toEqual({ Alpha: [], Beta: [], Gamma: [], Delta: [] })

  // Escape is no longer the key; the new one goes back to the open note.
  await noteRow(page, 'Beta').focus()
  await page.keyboard.press('Escape')
  expect(await selectedTitles(page)).toHaveLength(4)
  await page.keyboard.press('Control+Alt+KeyX')
  await expect(summary(page)).toHaveCount(0)
  expect(await selectedTitles(page)).toHaveLength(1)
})

test('the summary moves, pins, sets the status of and trashes every selected note', async ({
  page,
}) => {
  await fourNotes(page)
  await createBook(page, 'Work')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await pick(page, 'Delta', 'Beta', 'Alpha')
  const before = await stored(page)

  await summary(page).getByRole('button', { name: 'Move to Notebook…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move to Notebook' })
  await expect(dialog).toContainText('Choose a notebook for 3 notes.')
  await dialog.getByRole('option', { name: 'Work' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(book(page, 'Work')).toContainText('3')

  await pickStatus(summary(page), 'On Hold')
  await expect(sourceRow(page, 'On Hold')).toHaveText(/3$/)
  await summary(page).getByRole('button', { name: 'Pin to Top' }).click()
  await expect(summary(page).getByRole('button', { name: 'Unpin' })).toBeVisible()
  await expect(sourceRow(page, 'Pinned')).toHaveText(/3$/)
  // Still the same three notes, now in the pinned section.
  expect((await selectedTitles(page)).sort()).toEqual(['Alpha', 'Beta', 'Delta'])

  // One change per note, each with its own clock reading.
  const after = await stored(page)
  const three = ['Delta', 'Beta', 'Alpha'].map((title) => after[title]!)
  for (const field of ['bookHlc', 'statusHlc', 'pinnedHlc'] as const) {
    expect(new Set(three.map((n) => n[field])).size).toBe(3)
  }
  expect(three.map((n) => [n.status, n.pinned])).toEqual([
    ['on_hold', true],
    ['on_hold', true],
    ['on_hold', true],
  ])
  expect(after['Gamma']).toEqual(before['Gamma'])

  await summary(page).getByRole('button', { name: 'Unpin' }).click()
  await expect(sourceRow(page, 'Pinned')).toHaveText(/0$/)

  await summary(page).getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(summary(page)).toHaveCount(0)
  await expect(sourceRow(page, 'Trash')).toHaveText(/3$/)
})

test('the summary adds a tag to every selected note and removes one from all', async ({ page }) => {
  await fourNotes(page)
  await pick(page, 'Gamma', 'Alpha')
  const tags = summary(page).getByRole('group', { name: 'Tags' })
  await tags.getByRole('combobox', { name: 'Add Tag' }).fill('review')
  await tags.getByRole('combobox', { name: 'Add Tag' }).press('Enter')
  await expect(tags.getByText('review', { exact: true })).toBeVisible()
  await expect
    .poll(() => storedTags(page))
    .toEqual({
      Alpha: ['review'],
      Beta: [],
      Gamma: ['review'],
      Delta: [],
    })
  await tags.getByRole('button', { name: 'Remove Tag review' }).click()
  await expect.poll(() => storedTags(page)).toEqual({ Alpha: [], Beta: [], Gamma: [], Delta: [] })
})

test('Copy Note Links copies a link to each selected note, one per line', async ({ page }) => {
  await fourNotes(page)
  await pick(page, 'Delta', 'Gamma')
  await summary(page).getByRole('button', { name: 'Copy Note Links' }).click()
  await expect
    .poll(() => clipboardWrites(page))
    .toEqual([expect.stringMatching(/^\[Delta\]\(devot:\/\/note\/[^)]+\)\n\[Gamma\]\(devot:/)])
})

test('the context menu of a selected row acts on the whole selection', async ({ page }) => {
  await fourNotes(page)
  await pick(page, 'Delta', 'Gamma', 'Beta')
  await openMenu(page, 'Gamma')
  expect(await shownMenu(page)).toEqual([
    'Move Selected Notes to Notebook… M',
    '---',
    'Pin Selected Notes P',
    '---',
    'Status >',
    // Every one of them has no status yet.
    '  No Status Ctrl+CmdOrCtrl+1 [x]',
    '  Active Ctrl+CmdOrCtrl+2 [ ]',
    '  On Hold Ctrl+CmdOrCtrl+3 [ ]',
    '  Completed Ctrl+CmdOrCtrl+4 [ ]',
    '  Dropped Ctrl+CmdOrCtrl+5 [ ]',
    // None of them has a tag to remove yet.
    'Add Tag to Selected Notes…',
    '---',
    'Copy Note Links CmdOrCtrl+C',
    '---',
    'Move Selected Notes to Trash CmdOrCtrl+Backspace',
  ])
  await pickMenuItem(page, 'Completed', 'Status')
  await expect(sourceRow(page, 'Completed')).toHaveText(/3$/)
  await openMenu(page, 'Beta')
  expect(await shownMenu(page)).toContain('  Completed Ctrl+CmdOrCtrl+4 [x]')
  expect(await shownMenu(page)).toContain('  No Status Ctrl+CmdOrCtrl+1 [ ]')

  await pickMenuItem(page, 'Add Tag to Selected Notes…')
  const add = page.getByRole('dialog', { name: 'Add Tag' })
  await add.getByRole('combobox', { name: 'Filter tags' }).fill('later')
  await add.getByRole('combobox', { name: 'Filter tags' }).press('Enter')
  await expect(add).toHaveCount(0)
  await expect
    .poll(() => storedTags(page))
    .toEqual({
      Alpha: [],
      Beta: ['later'],
      Gamma: ['later'],
      Delta: ['later'],
    })
  await openMenu(page, 'Delta')
  await pickMenuItem(page, 'Remove Tag from Selected Notes…')
  const remove = page.getByRole('dialog', { name: 'Remove Tag' })
  await remove.getByRole('option', { name: 'later' }).click()
  await expect.poll(() => storedTags(page)).toEqual({ Alpha: [], Beta: [], Gamma: [], Delta: [] })

  // A row outside the selection: its own menu, for that note only.
  await openMenu(page, 'Alpha')
  expect(await shownMenu(page)).toContain('Pin to Top P')
  await pickMenuItem(page, 'Pin to Top')
  await expect(sourceRow(page, 'Pinned')).toHaveText(/1$/)
  expect((await selectedTitles(page)).sort()).toEqual(['Beta', 'Delta', 'Gamma'])

  await openMenu(page, 'Gamma')
  await pickMenuItem(page, 'Copy Note Links')
  await expect.poll(async () => (await clipboardWrites(page)).at(-1)?.split('\n').length).toBe(3)
  await openMenu(page, 'Gamma')
  await pickMenuItem(page, 'Move Selected Notes to Trash')
  await expect(noteRows(page)).toHaveCount(1)
})

test('the list keys and the palette act on the selection', async ({ page }) => {
  await fourNotes(page)
  await createBook(page, 'Home')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await pick(page, 'Gamma', 'Beta')
  // P pins both; the status keys work from anywhere.
  await page.keyboard.press('p')
  await expect(sourceRow(page, 'Pinned')).toHaveText(/2$/)
  await page.keyboard.press('Meta+Control+2')
  await expect(sourceRow(page, 'Active')).toHaveText(/2$/)

  await runCommand(page, 'Move Selected Notes to Notebook…')
  const dialog = page.getByRole('dialog', { name: 'Move to Notebook' })
  await dialog.getByRole('combobox', { name: 'Filter notebooks' }).fill('Home')
  await dialog.getByRole('combobox', { name: 'Filter notebooks' }).press('Enter')
  await expect(book(page, 'Home')).toContainText('2')

  // The palette's tag, pin and link commands, on both notes.
  await runCommand(page, 'Add Tag to Selected Notes…')
  const add = page.getByRole('dialog', { name: 'Add Tag' })
  await add.getByRole('combobox', { name: 'Filter tags' }).fill('later')
  await add.getByRole('combobox', { name: 'Filter tags' }).press('Enter')
  await expect(add).toHaveCount(0)
  await expect
    .poll(() => storedTags(page))
    .toEqual({ Alpha: [], Beta: ['later'], Gamma: ['later'], Delta: [] })
  await runCommand(page, 'Remove Tag from Selected Notes…')
  await page
    .getByRole('dialog', { name: 'Remove Tag' })
    .getByRole('option', { name: 'later' })
    .click()
  await expect.poll(() => storedTags(page)).toEqual({ Alpha: [], Beta: [], Gamma: [], Delta: [] })
  await runCommand(page, 'Unpin Selected Notes')
  await expect(sourceRow(page, 'Pinned')).toHaveText(/0$/)
  await runCommand(page, 'Pin Selected Notes')
  await expect(sourceRow(page, 'Pinned')).toHaveText(/2$/)
  const pinned = await stored(page)
  expect([pinned['Gamma']?.pinned, pinned['Beta']?.pinned, pinned['Delta']?.pinned]).toEqual([
    true,
    true,
    false,
  ])
  await runCommand(page, 'Copy Note Links')
  await expect
    .poll(async () => (await clipboardWrites(page)).at(-1))
    .toMatch(/^\[Gamma\]\(devot:\/\/note\/[^)]+\)\n\[Beta\]\(devot:/)

  await noteRow(page, 'Gamma').focus()
  await page.keyboard.press('Meta+Backspace')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(sourceRow(page, 'Trash')).toHaveText(/2$/)

  // The palette's Move to Trash.
  await page.getByRole('button', { name: /All Notes/ }).click()
  await pick(page, 'Delta', 'Alpha')
  await runCommand(page, 'Move Selected Notes to Trash')
  await expect(noteRows(page)).toHaveCount(0)
  await expect(sourceRow(page, 'Trash')).toHaveText(/4$/)
})

test('export and print act on one note: not offered or run while several are selected', async ({
  page,
}) => {
  await fourNotes(page)
  await page.evaluate(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = { note_print: true }
  })
  const printed = () =>
    page.evaluate(
      () =>
        (globalThis as unknown as TestWindow).devotIpcCalls.filter((c) => c.cmd === 'note_print')
          .length,
    )
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const exportCommands = palette
    .getByRole('option')
    .filter({ hasText: /^(Export as|Copy as|Print…)/ })
  const searchPalette = async (text: string) => {
    await page.keyboard.press('Meta+k')
    await palette.getByRole('combobox').fill(text)
  }

  await pick(page, 'Gamma', 'Beta')
  for (const text of ['Export', 'Copy as', 'Print']) {
    await searchPalette(text)
    await expect(exportCommands).toHaveCount(0)
    // Escape clears the query, then closes.
    await palette.getByRole('combobox').press('Escape')
    await palette.getByRole('combobox').press('Escape')
    await expect(palette).toHaveCount(0)
  }
  // Shift+Cmd+P prints nothing, from a row of the selection or the summary.
  await noteRow(page, 'Gamma').focus()
  await page.keyboard.press('Meta+Shift+P')
  await summary(page).getByRole('button', { name: 'Copy Note Links' }).focus()
  await page.keyboard.press('Meta+Shift+P')
  await expect(summary(page)).toBeVisible()
  expect(await printed()).toBe(0)

  // One note again: the palette offers them and the key prints it.
  await noteRow(page, 'Gamma').focus()
  await page.keyboard.press('Escape')
  await expect(summary(page)).toHaveCount(0)
  await searchPalette('Export')
  await expect(exportCommands).toHaveCount(3)
  // Escape clears the query, then closes.
  await palette.getByRole('combobox').press('Escape')
  await palette.getByRole('combobox').press('Escape')
  await searchPalette('Print')
  await expect(exportCommands).toHaveCount(1)
  // Escape clears the query, then closes.
  await palette.getByRole('combobox').press('Escape')
  await palette.getByRole('combobox').press('Escape')
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+P')
  await expect.poll(printed).toBe(1)
})

test('in the Trash, several notes are restored or deleted permanently at once', async ({
  page,
}) => {
  await fourNotes(page)
  await pick(page, 'Delta', 'Gamma', 'Beta')
  await summary(page).getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await sourceRow(page, 'Trash').click()
  await expect(noteRows(page)).toHaveCount(3)
  // Notes trashed together may share a deletion time: their order is not fixed.
  const shown = await noteRows(page).locator('.row-title, .row-headline').allTextContents()
  await noteRow(page, shown[0]!).click()
  await noteRow(page, shown[2]!).click({ modifiers: ['Shift'] })
  expect(await selectedTitles(page)).toEqual(shown)
  await expect(summary(page).getByRole('button', { name: 'Move to Trash' })).toHaveCount(0)

  await noteRow(page, shown[1]!).click({ modifiers: ['Meta'] })
  // The Trash list's Delete Permanently key asks about both notes.
  await page.keyboard.press('Meta+Backspace')
  const ask = page.getByRole('dialog')
  await expect(ask).toContainText('Permanently delete 2 notes?')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(3)

  await runCommand(page, 'Restore Selected Notes')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(noteRows(page).locator('.row-title')).toHaveText([shown[1]!])
  await expect(sourceRow(page, 'All Notes')).toHaveText(/3$/)

  await page.getByRole('button', { name: /All Notes/ }).click()
  await pick(page, shown[0]!, shown[2]!)
  await summary(page).getByRole('button', { name: 'Move to Trash' }).click()
  await sourceRow(page, 'Trash').click()
  await noteRows(page).first().click()
  await page.keyboard.press('Meta+a')
  await expect(summary(page).getByRole('heading')).toHaveText('3 Notes Selected')
  await summary(page).getByRole('button', { name: 'Delete Permanently' }).click()
  const confirm = page.getByRole('dialog')
  await expect(confirm).toContainText('Permanently delete 3 notes?')
  await confirm.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  // Purged notes keep only an empty tombstone.
  expect(Object.keys(await stored(page)).sort()).toEqual(['', 'Alpha'])
})

test('dragging selected notes onto a notebook, a tag, a status or the Trash changes them all', async ({
  page,
}) => {
  await fourNotes(page)
  await createBook(page, 'Work')
  await page.getByRole('button', { name: /All Notes/ }).click()
  // A tag to drop on: Alpha carries it.
  await noteRow(page, 'Alpha').click()
  await page.getByRole('combobox', { name: 'Add Tag' }).fill('ideas')
  await page.getByRole('combobox', { name: 'Add Tag' }).press('Enter')
  await expect(sourceRow(page, 'ideas')).toHaveText(/1$/)

  await pick(page, 'Delta', 'Gamma')
  await noteRow(page, 'Gamma').dragTo(bookRow(page, 'Work'))
  await expect(book(page, 'Work')).toContainText('2')
  await noteRow(page, 'Delta').dragTo(sourceRow(page, 'ideas'))
  await expect(sourceRow(page, 'ideas')).toHaveText(/3$/)
  await noteRow(page, 'Gamma').dragTo(sourceRow(page, 'Dropped'))
  await expect(sourceRow(page, 'Dropped')).toHaveText(/2$/)
  expect((await selectedTitles(page)).sort()).toEqual(['Delta', 'Gamma'])

  // A row outside the selection drags alone.
  await noteRow(page, 'Beta').dragTo(sourceRow(page, 'Active'))
  await expect(sourceRow(page, 'Active')).toHaveText(/1$/)
  await expect(sourceRow(page, 'Dropped')).toHaveText(/2$/)

  await noteRow(page, 'Delta').dragTo(sourceRow(page, 'Trash'))
  await expect(sourceRow(page, 'Trash')).toHaveText(/2$/)
  await expect(noteRows(page).locator('.row-title')).toHaveText(['Beta', 'Alpha'])
  await sourceRow(page, 'Trash').click()
  await expect(noteRows(page)).toHaveCount(2)
  expect((await noteRows(page).locator('.row-title').allTextContents()).sort()).toEqual([
    'Delta',
    'Gamma',
  ])
})

test('status, tag and Trash rows show where notes will drop', async ({ page }) => {
  await createNote(page, 'Wanderer')
  const data = await page.evaluateHandle(() => {
    const transfer = new (
      globalThis as unknown as {
        DataTransfer: new () => { setData(type: string, value: string): void }
      }
    ).DataTransfer()
    transfer.setData('application/x-devot-note', 'note')
    return transfer
  })
  for (const name of ['Active', 'Trash']) {
    const target = sourceRow(page, name)
    await target.dispatchEvent('dragenter', { dataTransfer: data })
    await target.dispatchEvent('dragover', { dataTransfer: data })
    await expect(target).toHaveClass(/drop-fill/)
    await noteRow(page, 'Wanderer').dispatchEvent('dragend', { dataTransfer: data })
    await expect(target).not.toHaveClass(/drop-fill/)
  }
  // All Notes takes no notes.
  const all = page.getByRole('button', { name: /All Notes/ })
  await all.dispatchEvent('dragover', { dataTransfer: data })
  await expect(all).not.toHaveClass(/drop-target/)
})

test('Next, Previous and Back leave the selection from the note that stayed open', async ({
  page,
}) => {
  await fourNotes(page)
  await noteRow(page, 'Delta').click()
  await noteRow(page, 'Gamma').click()
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
  // Gamma stayed open: the next note is Beta.
  await page.keyboard.press('Meta+Shift+]')
  await expect(summary(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Beta')
  expect(await selectedTitles(page)).toEqual(['Beta'])

  await noteRow(page, 'Delta').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(summary(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Gamma')
})

test('templates drop on notebooks and the Trash, not on a status or a tag', async ({ page }) => {
  await createBook(page, 'Work')
  await page.getByRole('button', { name: /All Notes/ }).click()
  // A tag row to drop on.
  await createNote(page, 'Plain')
  await page.getByRole('combobox', { name: 'Add Tag' }).fill('ideas')
  await page.getByRole('combobox', { name: 'Add Tag' }).press('Enter')
  await expect(sourceRow(page, 'ideas')).toHaveText(/1$/)
  await createTemplates(page, 'One', 'Two', 'Three', 'Four')
  await pick(page, 'Four', 'Three')
  await expect
    .poll(async () => Object.keys(await stored(page)).sort())
    .toEqual(['Four', 'One', 'Plain', 'Three', 'Two'])
  const before = await stored(page)
  // A drag of templates: no status or tag row shows itself as a target.
  const data = await page.evaluateHandle(() => {
    const transfer = new (
      globalThis as unknown as {
        DataTransfer: new () => { setData(type: string, value: string): void }
      }
    ).DataTransfer()
    transfer.setData('application/x-devot-note', 'note')
    transfer.setData('application/x-devot-template', '')
    return transfer
  })
  for (const name of ['Active', 'ideas']) {
    const target = sourceRow(page, name)
    await target.dispatchEvent('dragenter', { dataTransfer: data })
    await target.dispatchEvent('dragover', { dataTransfer: data })
    await expect(target).not.toHaveClass(/drop-fill/)
  }
  await noteRow(page, 'Four').dispatchEvent('dragend', { dataTransfer: data })
  // Dropped there anyway: nothing changes.
  await noteRow(page, 'Four').dragTo(sourceRow(page, 'Active'))
  await noteRow(page, 'Three').dragTo(sourceRow(page, 'ideas'))
  await page.waitForTimeout(300)
  expect(await stored(page)).toEqual(before)
  expect((await storedTags(page))['Four']).toEqual([])
  expect((await storedTags(page))['Three']).toEqual([])
  await expect(sourceRow(page, 'Active')).toHaveText(/0$/)
  await expect(sourceRow(page, 'ideas')).toHaveText(/1$/)

  // Copy Note Links and Move to Trash from the summary.
  await summary(page).getByRole('button', { name: 'Copy Note Links' }).click()
  await expect
    .poll(async () => (await clipboardWrites(page)).at(-1))
    .toMatch(/^\[Four\]\(devot:\/\/note\/[^)]+\)\n\[Three\]\(devot:/)
  await summary(page).getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page).locator('.row-title')).toHaveText(['Two', 'One'])
  await expect(sourceRow(page, 'Trash')).toHaveText(/2$/)

  // Onto a notebook: both leave Templates.
  await pick(page, 'Two', 'One')
  await noteRow(page, 'One').dragTo(bookRow(page, 'Work'))
  await expect(noteRows(page)).toHaveCount(0)
  await expect(book(page, 'Work')).toContainText('2')
})

test('Next and Previous Note step through the templates in Templates', async ({ page }) => {
  await createNote(page, 'Plain')
  await createTemplates(page, 'One', 'Two')
  await expect(noteRows(page).locator('.row-title')).toHaveText(['Two', 'One'])
  const headline = page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
  await noteRow(page, 'Two').click()
  await expect(titleField(page)).toHaveValue('Two')
  await page.keyboard.press('Meta+Shift+]')
  await expect(titleField(page)).toHaveValue('One')
  await expect(headline).toHaveText('Templates')
  expect(await selectedTitles(page)).toEqual(['One'])
  await page.keyboard.press('Meta+Shift+[')
  await expect(titleField(page)).toHaveValue('Two')
  await expect(headline).toHaveText('Templates')
})

test('ending a selection leaves the keyboard on the list, even after a new note', async ({
  page,
}) => {
  await createNote(page, 'Alpha')
  // Beta is new: its editor took the keyboard when it opened.
  await createNote(page, 'Beta')
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(titleField(page)).toHaveValue('Beta')
  await expect(noteRow(page, 'Beta')).toBeFocused()
  // The list keys still act on the note, not on its text.
  await page.keyboard.press('p')
  await expect(sourceRow(page, 'Pinned')).toHaveText(/1$/)
  await expect(body(page)).toHaveText('')

  // A new note, then a row Cmd-clicked in and out again: the same.
  await createNote(page, 'Gamma')
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toBeVisible()
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(summary(page)).toHaveCount(0)
  await expect(noteRow(page, 'Alpha')).toBeFocused()
})

test('a Shift-click that leaves the open note out keeps the keyboard on the clicked row', async ({
  page,
}) => {
  await fourNotes(page)
  await noteRow(page, 'Delta').click()
  await noteRow(page, 'Beta').click({ modifiers: ['Meta'] })
  await noteRow(page, 'Alpha').click({ modifiers: ['Shift'] })
  expect(await selectedTitles(page)).toEqual(['Beta', 'Alpha'])
  // Beta, the anchor, is the open note now; the keyboard stays on Alpha.
  await page.waitForTimeout(200)
  await expect(noteRow(page, 'Alpha')).toBeFocused()

  // Cmd-clicking the open note out of three: the keyboard stays on it.
  await noteRow(page, 'Gamma').click({ modifiers: ['Meta'] })
  await noteRow(page, 'Beta').click({ modifiers: ['Meta'] })
  expect(await selectedTitles(page)).toEqual(['Gamma', 'Alpha'])
  await page.waitForTimeout(200)
  await expect(noteRow(page, 'Beta')).toBeFocused()
})

test('in Templates the summary offers no status or tags', async ({ page }) => {
  await createTemplates(page, 'One', 'Two')
  await pick(page, 'Two', 'One')
  await expect(statusPicker(summary(page))).toHaveCount(0)
  await expect(summary(page).getByRole('group', { name: 'Tags' })).toHaveCount(0)
  await summary(page).getByRole('button', { name: 'Pin to Top' }).click()
  await expect(list(page).locator('.list-section', { hasText: 'Pinned' })).toBeVisible()
})

test('a note that cannot be changed is reported, and the others still change', async ({ page }) => {
  await createNote(page, 'Locked')
  await createNote(page, 'Free')
  // The store refuses to save Locked pinned (a write failing part-way).
  await page.evaluate(() => {
    type Setter = (this: unknown, key: string, value: string) => void
    const proto = (globalThis as unknown as { Storage: { prototype: { setItem: Setter } } }).Storage
      .prototype
    const setItem = proto.setItem
    proto.setItem = function (key, value) {
      if (key === 'devot.test.notes') {
        const notes = JSON.parse(value) as { title: string; pinned: boolean }[]
        if (notes.some((n) => n.title === 'Locked' && n.pinned)) throw new Error('E_TEST_FULL')
      }
      setItem.call(this, key, value)
    }
  })
  await pick(page, 'Free', 'Locked')
  await summary(page).getByRole('button', { name: 'Pin to Top' }).click()
  // In the notice stack with the others, not above the editor.
  const notice = page.locator('.notices').getByRole('alert')
  await expect(notice).toHaveText(/Could not change 1 note\./)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  expect((await stored(page))['Free']?.pinned).toBe(true)
  expect((await stored(page))['Locked']?.pinned).toBe(false)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
})

test('Return on a row of a selection edits the open note alone', async ({ page }) => {
  await fourNotes(page)
  await pick(page, 'Gamma', 'Beta')
  await noteRow(page, 'Beta').focus()
  await page.keyboard.press('Enter')
  await expect(summary(page)).toHaveCount(0)
  await expect(titleField(page)).toBeFocused()
  await expect(titleField(page)).toHaveValue('Gamma')
})

test('a selection ends with its view and its summary tag field takes nothing off by itself', async ({
  page,
}) => {
  await fourNotes(page)
  await pick(page, 'Delta', 'Gamma')
  // No tags yet: nothing to remove.
  await openMenu(page, 'Gamma')
  expect(await shownMenu(page)).not.toContain('Remove Tag from Selected Notes…')
  const field = summary(page).getByRole('combobox', { name: 'Add Tag' })
  await field.fill('shared')
  await field.press('Enter')
  await expect(summary(page).getByRole('group', { name: 'Tags' })).toContainText('shared')
  await field.press('Backspace')
  await page.waitForTimeout(300)
  expect((await storedTags(page))['Delta']).toEqual(['shared'])

  // Another view, then back: the selection does not come back.
  await sourceRow(page, 'Trash').click()
  await page.getByRole('button', { name: /All Notes/ }).click()
  await expect(noteRows(page)).toHaveCount(4)
  await expect(summary(page)).toHaveCount(0)
  expect(await selectedTitles(page)).toEqual([])
})

test('Copy Note Links copies the links of 1,500 notes', async ({ page }) => {
  await seedNotes(page, 1500)
  const caption = page.getByRole('toolbar', { name: 'Toolbar' }).first().locator('.caption')
  await expect(caption).toHaveText('1,500 notes')
  const row = (title: string) =>
    noteRows(page).filter({
      has: page.locator('.row-title', { hasText: new RegExp(`^${title}$`) }),
    })
  await expect(row('Note 1')).toBeVisible()
  // The command takes what Rust takes, and no more.
  await page.evaluate((limit) => {
    const w = globalThis as unknown as TestWindow & { devotClipboard?: string }
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      clipboard_write_text: (args: { text: string }) => {
        if (new TextEncoder().encode(args.text).length > limit) {
          throw new Error('E_CLIPBOARD_TEXT_TOO_LONG')
        }
        w.devotClipboard = args.text
        return null
      },
    }
  }, NATIVE_CLIPBOARD_LIMIT)
  // From the first note to the last (the list renders the rows that show).
  await row('Note 1').click()
  await expect(titleField(page)).toHaveValue('Note 1')
  await list(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await row('Note 1500').click({ modifiers: ['Shift'] })
  await expect(summary(page)).toContainText('1,500 Notes Selected')
  await summary(page).getByRole('button', { name: 'Copy Note Links' }).click()
  const copied = () =>
    page.evaluate(() => (globalThis as unknown as { devotClipboard?: string }).devotClipboard ?? '')
  await expect.poll(async () => (await copied()).split('\n').length).toBe(1500)
  const links = await copied()
  // Far more than the command once took (64 KiB).
  expect(new TextEncoder().encode(links).length).toBeGreaterThan(64 * 1024)
  expect(links.split('\n')[0]).toBe('[Note 1](devot://note/0192a6f0-0000-7000-8000-000000000001)')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('a copy that fails says so, with its code', async ({ page }) => {
  await fourNotes(page)
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      clipboard_write_text: { error: 'E_CLIPBOARD_WRITE_FAILED' },
    }
  })
  await pick(page, 'Delta', 'Gamma')
  await summary(page).getByRole('button', { name: 'Copy Note Links' }).click()
  const notice = page.getByRole('alert')
  await expect(notice).toHaveText(
    /The note links could not be copied \(E_CLIPBOARD_WRITE_FAILED\)\./,
  )
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  // One note's link, from its own menu (a row that is not selected).
  await openMenu(page, 'Beta')
  await pickMenuItem(page, 'Copy Note Link')
  await expect(notice).toHaveText(
    /The note link could not be copied \(E_CLIPBOARD_WRITE_FAILED\)\./,
  )
})
