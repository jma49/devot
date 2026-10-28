import type { Page } from '@playwright/test'
import {
  expect,
  pickMenuItem,
  shownMenu,
  test,
  pickNoteMore,
  openNotePinned,
  pickStatus,
  statusPicker,
  bookPicker,
  pickBook,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Revision History' })
const versions = (page: Page) => sheet(page).getByRole('listbox', { name: 'Versions' })
const entries = (page: Page) => versions(page).getByRole('option')
const changes = (page: Page) => sheet(page).getByRole('region', { name: 'Changes' })
const version = (page: Page) => entries(page).filter({ hasText: 'Earliest version' })

const savedBody = (page: Page, title: string) =>
  page.evaluate((t) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
      title: string
      bodyMd: string
    }[]
    return notes.find((n) => n.title === t)?.bodyMd
  }, title)

async function createNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  if (title) await titleField(page).fill(title)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(() => savedBody(page, title)).toBe(text)
}

/** Fresh session, so the saved text is the version before the next edit. */
async function reopen(page: Page, title: string) {
  await page.reload()
  await noteRow(page, title).click()
  await expect(titleField(page)).toHaveValue(title)
}

async function appendText(page: Page, text: string) {
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('compares a version with the note and restores it as one undo step', async ({ page }) => {
  await createNote(page, 'Plan', 'first line\nsecond line')
  await reopen(page, 'Plan')
  await appendText(page, '\nthird line')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line\nthird line')

  await pickNoteMore(page, 'Revision History\u2026')
  await expect(sheet(page)).toBeVisible()
  await expect(entries(page)).toHaveCount(2)
  await version(page).click()
  await expect(changes(page).locator('ins')).toHaveText(['third line'])
  await expect(changes(page).locator('del')).toHaveCount(0)

  await sheet(page).getByRole('button', { name: 'Restore' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect(body(page)).toHaveText('first linesecond line')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line\nthird line')
})

test('keys pressed while the sheet is open do not change the note under it', async ({ page }) => {
  await createNote(page, 'Plan', 'first line')
  await reopen(page, 'Plan')
  await appendText(page, '\nsecond line')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')

  await pickNoteMore(page, 'Revision History\u2026')
  await expect(sheet(page)).toBeVisible()
  await page.keyboard.press('Backspace')
  await page.keyboard.type('x')
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()
  await expect(body(page)).toHaveText('first linesecond line')
  await appendText(page, '!')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line!')
})

test('a diff taller than its box scrolls from the keyboard', async ({ page }) => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  await createNote(page, 'Plan', lines.join('\n'))
  await reopen(page, 'Plan')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(lines.map((text) => `${text} changed`).join('\n'))
  await expect.poll(() => savedBody(page, 'Plan')).toContain('line 39 changed')

  await pickNoteMore(page, 'Revision History…')
  await version(page).click()
  await expect(changes(page).locator('.diff-line')).toHaveCount(80)
  await changes(page).focus()
  await expect(changes(page)).toBeFocused()
  await page.keyboard.press('PageDown')
  await expect.poll(() => changes(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('a restore is an undo step apart from the typing before and after it', async ({ page }) => {
  await createNote(page, 'Plan', 'first line')
  await reopen(page, 'Plan')
  await appendText(page, '\nsecond line')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')

  await pickNoteMore(page, 'Revision History\u2026')
  await version(page).click()
  await sheet(page).getByRole('button', { name: 'Restore' }).click()
  await expect(sheet(page)).toBeHidden()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('!')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line!')

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line')
  // Redo: Shift+Cmd+Z on macOS; CodeMirror binds Ctrl+Y elsewhere.
  const redo = process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'
  await page.keyboard.press(redo)
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')
  await page.keyboard.press(redo)
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line')
})

test('lists title, notebook, status and pin changes with the versions', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const name = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(name).toHaveValue('New Notebook')
  await name.fill('Work')
  await name.press('Enter')
  await expect(page.getByRole('treeitem', { name: /^Work\b/ })).toBeVisible()
  await createNote(page, 'Draft', 'text')
  await reopen(page, 'Draft')
  await appendText(page, ' and more')
  await titleField(page).fill('Final')
  await expect(noteRow(page, 'Final')).toHaveCount(1)
  await pickStatus(page, 'Active')
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'active')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
  const notebook = bookPicker(page)
  await pickBook(page, 'No Notebook')
  await expect(notebook).toHaveAttribute('data-value', '')
  await pickBook(page, 'Work')
  await expect(notebook).not.toHaveAttribute('data-value', '')

  await pickNoteMore(page, 'Revision History\u2026')
  await expect(entries(page)).toHaveCount(7)
  await expect(entries(page).nth(0)).toContainText('Moved to Work')
  await expect(entries(page).nth(1)).toContainText('Removed from its notebook')
  await expect(entries(page).nth(2)).toContainText('Pinned')
  await expect(entries(page).nth(3)).toContainText('Status set to Active')
  await expect(entries(page).nth(4)).toContainText('Renamed to \u201cFinal\u201d')
  await expect(entries(page).filter({ hasText: 'Renamed to \u201cDraft\u201d' })).toHaveCount(1)
  // The only version is the oldest kept one: nothing was added at that point.
  await expect(version(page)).toContainText('Earliest version \u00b7 4 characters')
  await expect(entries(page).filter({ hasText: 'added' })).toHaveCount(0)
  await entries(page).first().click()
  await expect(sheet(page).getByRole('button', { name: 'Restore' })).toBeDisabled()
})

test('opens from the note menu, the menu bar and its shortcut; works by keyboard', async ({
  page,
}) => {
  // Untitled: a title event could be older or newer than the version, depending on whether title and text were saved together.
  await createNote(page, '', 'one')
  await reopen(page, '')
  await appendText(page, ' two')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)

  await noteRow(page, 'one two').click({ button: 'right' })
  await expect.poll(() => shownMenu(page)).toContain('Revision History\u2026 Alt+CmdOrCtrl+Y')
  await pickMenuItem(page, 'Revision History\u2026')
  await expect(sheet(page)).toBeVisible()

  await expect(versions(page)).toBeFocused()
  await expect(entries(page)).toHaveCount(2)
  await expect(entries(page).nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await expect(version(page)).toHaveAttribute('aria-selected', 'true')
  await expect(changes(page).locator('ins')).toHaveText(['one two'])
  await expect(changes(page).locator('del')).toHaveText(['one'])
  await page.keyboard.press('ArrowUp')
  await expect(version(page)).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('Home')
  await expect(entries(page).nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toBeHidden()

  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-history'))
  })
  await expect(sheet(page)).toBeVisible()
  await sheet(page).getByRole('button', { name: 'Done' }).click()
  await expect(sheet(page)).toBeHidden()

  // Option+Cmd+Y with the editor focused: the editor has its own keys
  // (Shift+Cmd+H is Highlight), so the note itself must stay as it was.
  await body(page).click()
  await page.keyboard.press('Meta+Alt+KeyY')
  await expect(sheet(page)).toBeVisible()
  await sheet(page).getByRole('button', { name: 'Done' }).click()
  await expect(body(page)).toHaveText('one two')
})

test('labels the oldest kept version apart from the changes after it', async ({ page }) => {
  await createNote(page, '', 'one')
  await reopen(page, '')
  await appendText(page, ' two')
  await expect.poll(() => savedBody(page, '')).toBe('one two')
  // A later session keeps 'one two' as a second version on its first edit.
  await reopen(page, '')
  await appendText(page, '!')
  await expect.poll(() => savedBody(page, '')).toBe('one two!')

  await pickNoteMore(page, 'Revision History\u2026')
  await expect(entries(page)).toHaveCount(2)
  await expect(entries(page).nth(0)).toContainText('4 characters added')
  await expect(entries(page).nth(1)).toContainText('Earliest version \u00b7 3 characters')
  await expect(entries(page).nth(1)).not.toContainText('added')
})

test('a new note has no versions yet', async ({ page }) => {
  await createNote(page, '', 'just typed')
  await pickNoteMore(page, 'Revision History\u2026')
  await expect(entries(page)).toHaveCount(0)
  await expect(sheet(page)).toContainText('No versions yet')
  await expect(sheet(page).getByRole('button', { name: 'Restore' })).toBeDisabled()
})

test('labels a version sync kept before a merge with another device', async ({ page }) => {
  await createNote(page, 'Merged', 'mine')
  await reopen(page, 'Merged')
  await appendText(page, ' and theirs')
  await expect.poll(() => savedBody(page, 'Merged')).toBe('mine and theirs')
  // What the sync engine writes before another device's state changes the note (#216).
  await page.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem('devot.test.revisions') ?? '[]') as {
      kind: string
      value: string | null
    }[]
    for (const revision of kept) if (revision.kind === 'body') revision.value = 'merge'
    localStorage.setItem('devot.test.revisions', JSON.stringify(kept))
  })
  await pickNoteMore(page, 'Revision History…')
  await expect(entries(page)).toHaveCount(2)
  await expect(entries(page).filter({ hasText: 'Before a merge with another device' })).toHaveCount(
    1,
  )
})
