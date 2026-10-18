import type { Page } from '@playwright/test'
import {
  clipboardWrites,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  type TestWindow,
  openNotePinned,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) =>
  noteRows(page).filter({ has: page.locator('.row-title, .row-headline', { hasText: title }) })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const picker = (page: Page) => page.getByRole('dialog', { name: 'Move to Notebook' })
const pinnedHeader = (page: Page) =>
  page.getByRole('listbox', { name: 'Notes' }).locator('.list-section', { hasText: 'Pinned' })
const URI = /^devot:\/\/note\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface StoredNote {
  id: string
  title: string
  bodyMd: string
  bookId: string | null
  pinned: boolean
  /** Empty until the pin was written once. */
  pinnedHlc: string
  deletedAt: number | null
}

/** The notes the in-memory store holds (saved state, not what is on screen). */
const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])

async function createNote(page: Page, title: string, text = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  if (text) {
    await body(page).click()
    await page.keyboard.insertText(text)
  }
  if (title) await expect(noteRow(page, title)).toHaveCount(1)
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })).toBeVisible()
}

/** Gives the keyboard to a note's row (clicking it also opens the note). */
async function focusRow(page: Page, title: string) {
  await noteRow(page, title).click()
  await expect(noteRow(page, title)).toBeFocused()
  await expect(titleField(page)).toHaveValue(title === 'Untitled' ? '' : title)
}

async function openMenu(page: Page, title: string) {
  const before = await popups(page)
  await noteRow(page, title).first().click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('right-click shows the native note menu, grouped, with its shortcuts', async ({ page }) => {
  await createNote(page, 'Plan')
  await openMenu(page, 'Plan')
  expect(await shownMenu(page)).toEqual([
    'Move to Notebook… M',
    'Revision History… Alt+CmdOrCtrl+Y',
    '---',
    'Duplicate CmdOrCtrl+D',
    'Pin to Top P',
    '---',
    'Copy Note Link CmdOrCtrl+C',
    'Copy Note URI Shift+CmdOrCtrl+C',
    'Copy Note ID',
    '---',
    'Export as HTML…',
    'Copy as HTML',
    'Copy as Simple HTML',
    'Export as Markdown…',
    'Export as PDF…',
    'Print… Shift+CmdOrCtrl+P',
    '---',
    'Move to Trash CmdOrCtrl+Backspace',
  ])
  // The web view's own menu is suppressed.
  const prevented = await noteRow(page, 'Plan').evaluate((el) => {
    const { MouseEvent } = globalThis as unknown as {
      MouseEvent: new (type: string, init: object) => { defaultPrevented: boolean }
    }
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    ;(el as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(true)
  await pickMenuItem(page, 'Pin to Top')
  await expect(pinnedHeader(page)).toBeVisible()
  await openMenu(page, 'Plan')
  expect(await shownMenu(page)).toContain('Unpin P')
  // One native menu for the window's life, not one per right-click.
  const menus = await page.evaluate(
    () =>
      Object.values((globalThis as unknown as TestWindow).devotMenus).filter(
        (m) => m.kind === 'Menu',
      ).length,
  )
  expect(menus).toBe(1)
})

test('menu items act on the clicked note, not the open one', async ({ page }) => {
  await createNote(page, 'Clicked')
  await createNote(page, 'Open')
  await openMenu(page, 'Clicked')
  await pickMenuItem(page, 'Copy Note URI')
  await pickMenuItem(page, 'Copy Note ID')
  await pickMenuItem(page, 'Copy Note Link')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(3)
  const [uri, id, link] = await clipboardWrites(page)
  expect(uri).toMatch(URI)
  expect(uri).toBe(`devot://note/${id}`)
  expect(link).toBe(`[Clicked](devot://note/${id})`)
  const clicked = (await stored(page)).find((n) => n.title === 'Clicked')
  expect(clicked?.id).toBe(id)

  await pickMenuItem(page, 'Pin to Top')
  await expect(pinnedHeader(page)).toBeVisible()
  await expect(titleField(page)).toHaveValue('Open')
  await expect.poll(() => openNotePinned(page)).toBe(false)

  await openMenu(page, 'Clicked')
  await pickMenuItem(page, 'Move to Trash')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(titleField(page)).toHaveValue('Open')
})

test('copy shortcuts write the link and the URI of the selected note', async ({ page }) => {
  await createNote(page, 'Plan [v2]')
  await createNote(page, '')
  await focusRow(page, 'Plan [v2]')
  await page.keyboard.press('Meta+KeyC')
  await page.keyboard.press('Meta+Shift+KeyC')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(2)
  const [link, uri] = await clipboardWrites(page)
  expect(uri).toMatch(URI)
  expect(link).toBe(`[Plan \\[v2\\]](${uri})`)

  // An untitled note links with the name the list shows.
  await focusRow(page, 'Untitled')
  await page.keyboard.press('Meta+KeyC')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(3)
  expect((await clipboardWrites(page))[2]).toMatch(
    /^\[Untitled\]\(devot:\/\/note\/[0-9a-f-]{36}\)$/,
  )
})

test('Duplicate copies the title, body and notebook and opens the copy', async ({ page }) => {
  await createBook(page, 'Work')
  await createNote(page, 'Weekly plan', '# Goals\n\nShip the menu.')
  await focusRow(page, 'Weekly plan')
  const original = (await stored(page)).find((n) => n.title === 'Weekly plan')
  await page.keyboard.press('Meta+KeyD')
  await expect(noteRow(page, 'Weekly plan')).toHaveCount(2)
  await expect.poll(async () => (await stored(page)).length).toBe(2)
  const copy = (await stored(page)).find((n) => n.id !== original?.id)
  expect(copy).toMatchObject({
    title: 'Weekly plan copy',
    bodyMd: '# Goals\n\nShip the menu.',
    bookId: original?.bookId,
  })
  expect(copy?.bookId).toBeTruthy()
  // The copy is open and keeps the keyboard in the list.
  await expect(body(page)).toContainText('Ship the menu.')
  await expect(noteRows(page).and(page.locator('[aria-selected="true"]'))).toBeFocused()
  await page.keyboard.press('Meta+Shift+KeyC')
  await expect.poll(() => clipboardWrites(page)).toEqual([`devot://note/${copy?.id}`])

  // From the menu, on a note that is not open.
  await createNote(page, 'Other')
  await openMenu(page, 'Weekly plan')
  await pickMenuItem(page, 'Duplicate')
  await expect(noteRow(page, 'Weekly plan')).toHaveCount(3)
  // The first row is the earlier copy, so this is a copy of a copy.
  await expect(titleField(page)).toHaveValue('Weekly plan copy copy')
})

test('P pins and unpins the selected note', async ({ page }) => {
  await createNote(page, 'First')
  await createNote(page, 'Second')
  await focusRow(page, 'First')
  await page.keyboard.press('KeyP')
  await expect(pinnedHeader(page)).toBeVisible()
  await expect.poll(() => openNotePinned(page)).toBe(true)
  // The row keeps the keyboard as it moves to the pinned section.
  await expect(noteRow(page, 'First')).toBeFocused()
  await page.keyboard.press('KeyP')
  await expect(pinnedHeader(page)).toHaveCount(0)
  await expect
    .poll(async () => (await stored(page)).find((n) => n.title === 'First')?.pinned)
    .toBe(false)
})

test('M opens a notebook picker that filters as you type', async ({ page }) => {
  await createBook(page, 'Work')
  await createBook(page, 'Home')
  await page
    .getByRole('treeitem', { name: /^Home\b/ })
    .locator('> .book-row')
    .click()
  await createNote(page, 'Errand')
  await focusRow(page, 'Errand')
  await page.keyboard.press('KeyM')
  await expect(picker(page)).toBeVisible()
  const filter = picker(page).getByRole('combobox', { name: 'Filter notebooks' })
  await expect(filter).toBeFocused()
  // The key that opened it is not typed into the filter.
  await expect(filter).toHaveValue('')
  const options = picker(page).getByRole('option')
  // Notebooks in the sidebar's order.
  await expect(options).toHaveText(['No Notebook', 'Work', 'Home'])
  await filter.pressSequentially('wo')
  await expect(options).toHaveText(['Work'])
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  // Home no longer lists it; Work does.
  await expect(noteRows(page)).toHaveCount(0)
  await page
    .getByRole('treeitem', { name: /^Work\b/ })
    .locator('> .book-row')
    .click()
  await expect(noteRow(page, 'Errand')).toHaveCount(1)
  const work = await page.evaluate(
    () =>
      (
        JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as {
          id: string
          name: string
        }[]
      ).find((b) => b.name === 'Work')?.id,
  )
  await expect.poll(async () => (await stored(page))[0]?.bookId).toBe(work)
})

test('the picker moves from the menu, by arrow keys or click, and Escape cancels', async ({
  page,
}) => {
  await createBook(page, 'Work')
  await page.getByRole('button', { name: /^All Notes/ }).click()
  await createNote(page, 'Loose')
  await createNote(page, 'Open')
  await openMenu(page, 'Loose')
  await pickMenuItem(page, 'Move to Notebook…')
  await expect(picker(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  expect((await stored(page)).every((n) => n.bookId === null)).toBe(true)

  await openMenu(page, 'Loose')
  await pickMenuItem(page, 'Move to Notebook…')
  // The note's current notebook is marked.
  await expect(picker(page).getByRole('option', { name: 'No Notebook' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(picker(page).getByRole('option', { name: 'Work' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  await expect
    .poll(async () => (await stored(page)).find((n) => n.title === 'Loose')?.bookId)
    .toBeTruthy()
  // The open note was not moved.
  expect((await stored(page)).find((n) => n.title === 'Open')?.bookId).toBeNull()

  await openMenu(page, 'Loose')
  await pickMenuItem(page, 'Move to Notebook…')
  await picker(page).getByRole('option', { name: 'No Notebook' }).click()
  await expect
    .poll(async () => (await stored(page)).find((n) => n.title === 'Loose')?.bookId)
    .toBeNull()
})

test('Cmd+Delete moves the selected note to the trash', async ({ page }) => {
  await createNote(page, 'Keep')
  await createNote(page, 'Drop')
  await focusRow(page, 'Drop')
  await page.keyboard.press('Meta+Backspace')
  await expect(noteRows(page)).toHaveText([/Keep/])
  await expect
    .poll(async () => (await stored(page)).find((n) => n.title === 'Drop')?.deletedAt)
    .toBeTruthy()
})

test('shortcuts do nothing while the editor or a text field has focus', async ({ page }) => {
  await createNote(page, 'Typing', 'mp')
  // The editor: keys type, and Cmd+C stays the editor's (Cmd+D and
  // Shift+Cmd+C are editor commands there: Delete Line and Code Block).
  await body(page).click()
  await page.keyboard.press('KeyM')
  await page.keyboard.press('KeyP')
  await page.keyboard.press('Meta+KeyC')
  await expect(body(page)).toContainText('mpmp')
  // The title and the search field.
  await titleField(page).click()
  await page.keyboard.press('KeyM')
  await page.keyboard.press('Meta+KeyD')
  await expect(titleField(page)).toHaveValue('Typingm')
  // Cmd+Delete edits the title (how depends on the platform's text editing), and
  // never trashes the note: checked at the end.
  await page.keyboard.press('Meta+Backspace')
  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.click()
  await page.keyboard.press('KeyP')
  await page.keyboard.press('Meta+KeyD')
  await search.fill('')
  await page.waitForTimeout(400)
  await expect(picker(page)).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(1)
  await expect(pinnedHeader(page)).toHaveCount(0)
  expect(await clipboardWrites(page)).toEqual([])
  expect((await stored(page)).every((n) => !n.pinned && n.deletedAt === null)).toBe(true)
})

test('a copied link opens its note from the preview', async ({ page }) => {
  await createNote(page, 'Target')
  await createNote(page, 'Source')
  await openMenu(page, 'Target')
  await pickMenuItem(page, 'Copy Note Link')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(1)
  const [link] = await clipboardWrites(page)
  await body(page).click()
  await page.keyboard.insertText(`See ${link}.`)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview' })
    .click()
  await page.getByRole('article', { name: 'Preview' }).getByRole('link', { name: 'Target' }).click()
  await expect(titleField(page)).toHaveValue('Target')
})

test('the Trash offers only its own menu and no note shortcuts', async ({ page }) => {
  await createNote(page, 'Old')
  await focusRow(page, 'Old')
  await page.keyboard.press('Meta+Backspace')
  await page.getByRole('button', { name: /^Trash\b/ }).click()
  await expect(noteRow(page, 'Old')).toHaveCount(1)
  // The right-click menu holds the Trash's actions only, no note items.
  await noteRow(page, 'Old').click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(1)
  expect(await shownMenu(page)).toEqual([
    'Restore from Trash',
    '---',
    expect.stringMatching(/^Delete Permanently/),
  ])
  await noteRow(page, 'Old').click()
  await page.keyboard.press('KeyP')
  await page.keyboard.press('Meta+KeyC')
  await page.keyboard.press('Meta+KeyD')
  await page.waitForTimeout(300)
  expect(await popups(page)).toBe(1)
  expect(await clipboardWrites(page)).toEqual([])
  expect(await stored(page)).toHaveLength(1)
})

test('shortcuts act on the row the keyboard is on after a right-click on another row', async ({
  page,
}) => {
  await createNote(page, 'Other')
  await createNote(page, 'Open')
  await focusRow(page, 'Open')
  await openMenu(page, 'Other')
  await page.keyboard.press('KeyP')
  await expect
    .poll(async () => (await stored(page)).map((n) => [n.title, n.pinned]).sort())
    .toEqual([
      ['Open', false],
      ['Other', true],
    ])
})

test('after duplicating into a filtered-out copy, shortcuts act on the copy', async ({ page }) => {
  await createNote(page, 'Pinned plan')
  await focusRow(page, 'Pinned plan')
  await page.keyboard.press('KeyP')
  await expect(pinnedHeader(page)).toBeVisible()
  await page.getByRole('button', { name: /^Pinned\b/ }).click()
  await focusRow(page, 'Pinned plan')
  await page.keyboard.press('Meta+KeyD')
  await expect.poll(async () => (await stored(page)).length).toBe(2)
  // The copy is not pinned, so the Pinned list would leave it out: All Notes
  // shows instead, with the copy open and listed.
  await expect(page.locator('.list .headline')).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
  const copy = (await stored(page)).find((n) => !n.pinned)
  await expect(noteRows(page).and(page.locator('[aria-selected="true"]'))).toHaveAttribute(
    'data-note-id',
    copy?.id ?? '',
  )
  await expect.poll(() => openNotePinned(page)).toBe(false)
  await page.keyboard.press('Meta+Shift+KeyC')
  await expect.poll(() => clipboardWrites(page)).toEqual([`devot://note/${copy?.id}`])
})

test('pressing P twice quickly pins and then unpins', async ({ page }) => {
  await createNote(page, 'Quick')
  await focusRow(page, 'Quick')
  // Both presses land before the list has caught up with the first one.
  await noteRow(page, 'Quick').evaluate((el) => {
    const { KeyboardEvent } = globalThis as unknown as {
      KeyboardEvent: new (type: string, init: object) => unknown
    }
    const row = el as unknown as { dispatchEvent(e: unknown): void }
    for (let i = 0; i < 2; i++) {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true }))
    }
  })
  // The positive signal first: the pin was written (its clock is set) and
  // is off again, so both presses ran. A swallowed second press would leave
  // it pinned; a swallowed first one leaves the clock empty.
  await expect
    .poll(async () => {
      const note = (await stored(page))[0]
      return { pinned: note?.pinned, written: (note?.pinnedHlc ?? '') !== '' }
    })
    .toEqual({ pinned: false, written: true })
  await expect(pinnedHeader(page)).toHaveCount(0)
})

test('fast arrow keys reach the last row while notes are still opening', async ({ page }) => {
  for (let i = 0; i < 10; i++) await createNote(page, `N${i}`)
  const rows = noteRows(page)
  await rows.first().click()
  await expect(rows.first()).toBeFocused()
  // No waits: earlier notes finish opening after the keyboard has moved on,
  // and must not pull the focus back to their rows.
  await page.evaluate(async () => {
    const { document, KeyboardEvent, setTimeout } = globalThis as unknown as {
      document: { activeElement: { dispatchEvent(e: unknown): void } }
      KeyboardEvent: new (type: string, init: object) => unknown
      setTimeout: (f: () => void, ms: number) => void
    }
    for (let i = 0; i < 9; i++) {
      const key = { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', key))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
  })
  await expect(rows.last()).toHaveAttribute('aria-selected', 'true')
  await expect(rows.last()).toBeFocused()
  await page.waitForTimeout(300)
  await expect(rows.last()).toBeFocused()
  await expect(titleField(page)).toHaveValue(await rows.last().locator('.row-title').innerText())
})

test('in search results, Duplicate focuses the copy and the menu works', async ({ page }) => {
  await createNote(page, 'Alpha plan')
  await createNote(page, 'Other')
  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.fill('Alpha')
  await expect(page.locator('.list .headline')).toHaveText('Search Results')
  await expect(noteRows(page)).toHaveCount(1)
  await focusRow(page, 'Alpha plan')
  const original = (await stored(page)).find((n) => n.title === 'Alpha plan')
  await page.keyboard.press('Meta+KeyD')
  await expect.poll(async () => (await stored(page)).length).toBe(3)
  await expect(noteRows(page)).toHaveCount(2)
  const copy = (await stored(page)).find((n) => n.title === 'Alpha plan copy')
  const selectedRow = noteRows(page).and(page.locator('[aria-selected="true"]'))
  await expect(selectedRow).toHaveCount(1)
  await expect(selectedRow).toBeFocused()
  // The keyboard and the shortcuts both act on the copy.
  await page.keyboard.press('Meta+Shift+KeyC')
  await expect.poll(() => clipboardWrites(page)).toEqual([`devot://note/${copy?.id}`])

  // The note menu in search results, on the original.
  const before = await popups(page)
  await noteRows(page).and(page.locator('[aria-selected="false"]')).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  await pickMenuItem(page, 'Copy Note ID')
  await expect.poll(() => clipboardWrites(page)).toEqual([`devot://note/${copy?.id}`, original?.id])
})
