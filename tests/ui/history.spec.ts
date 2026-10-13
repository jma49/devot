import type { Page } from '@playwright/test'
import { expect, pickMenuItem, shownMenu, test, pickNoteMore, openNotePinned } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Revision History' })
const versions = (page: Page) => sheet(page).getByRole('listbox', { name: 'Versions' })
const entries = (page: Page) => versions(page).getByRole('option')
const changes = (page: Page) => sheet(page).getByRole('region', { name: 'Changes' })
/** The oldest kept version: here, the only one. */
const version = (page: Page) => entries(page).filter({ hasText: 'Earliest version' })

/** The saved body of the note with this title (what the store holds). */
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

/** Opens a note in a fresh session, so its saved text is the version before the next edit. */
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
  // The version and the note's naming.
  await expect(entries(page)).toHaveCount(2)
  await version(page).click()
  await expect(changes(page).locator('ins')).toHaveText(['third line'])
  await expect(changes(page).locator('del')).toHaveCount(0)

  await sheet(page).getByRole('button', { name: 'Restore' }).click()
  await expect(sheet(page)).toBeHidden()
  await expect(body(page)).toHaveText('first linesecond line')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line')

  // Undo takes back the whole restore, and nothing before it.
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line\nsecond line\nthird line')
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
  // Typing right after the restore, where it ended.
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('!')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('first line!')

  // Undo: the typing, then the restore, then the typing before it.
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
  // The restore comes back as one step.
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
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' })
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('active')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
  const notebook = page.getByRole('combobox', { name: 'Notebook' })
  await notebook.selectOption({ label: 'No Notebook' })
  await expect(notebook).toHaveValue('')
  await notebook.selectOption({ label: 'Work' })
  await expect(notebook).not.toHaveValue('')

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
  // A metadata event cannot be restored.
  await entries(page).first().click()
  await expect(sheet(page).getByRole('button', { name: 'Restore' })).toBeDisabled()
})

test('opens from the note menu, the menu bar and its shortcut; works by keyboard', async ({
  page,
}) => {
  // Untitled: a title event could be older or newer than the version,
  // depending on whether the title and the text were saved together.
  await createNote(page, '', 'one')
  await reopen(page, '')
  await appendText(page, ' two')
  await pickNoteMore(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)

  // The note menu.
  // Its row shows its first line.
  await noteRow(page, 'one two').click({ button: 'right' })
  await expect.poll(() => shownMenu(page)).toContain('Revision History\u2026 Alt+CmdOrCtrl+Y')
  await pickMenuItem(page, 'Revision History\u2026')
  await expect(sheet(page)).toBeVisible()

  // The list takes the keyboard: arrows pick an entry, Escape closes.
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

  // View > Revision History (the menu bar sends this event).
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
  // Untitled, so the list holds only the two versions.
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
