import type { Page } from '@playwright/test'
import {
  expect,
  pickMenuItem,
  pickNoteMore,
  pickStatus,
  shownMenu,
  test,
  type TestWindow,
} from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const row = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

/** The menu's lines without their keys. */
async function labels(page: Page): Promise<string[]> {
  return (await shownMenu(page)).map((line) =>
    line.replace(/ (?:(?:Cmd|Ctrl|Alt|Shift|Super|CmdOrCtrl)\+)*(?:Backspace|\S\S*)$/, (m) =>
      /\+|Backspace/.test(m) ? '' : m,
    ),
  )
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

/** Opens a menu with `open` and waits until the app has popped it up. */
async function popUp(page: Page, open: () => Promise<void>) {
  const before = await popups(page)
  await open()
  await expect.poll(() => popups(page)).toBe(before + 1)
}

/** Moves the open note to the Trash and waits until the Trash count shows it. */
async function trashOpenNote(page: Page) {
  const before = Number((await row(page, 'Trash').textContent())?.match(/(\d+)$/)?.[1] ?? 0)
  await pickNoteMore(page, 'Move to Trash')
  await expect(row(page, 'Trash')).toHaveText(new RegExp(`${before + 1}$`))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the Trash row shows Empty Trash only while the Trash has notes, and asks to confirm', async ({
  page,
}) => {
  // An empty Trash has nothing to offer: no menu opens.
  const before = await popups(page)
  await row(page, 'Trash').click({ button: 'right' })
  expect(await popups(page)).toBe(before)

  await createNote(page, 'One')
  await trashOpenNote(page)
  await createNote(page, 'Two')
  await trashOpenNote(page)

  await popUp(page, () => row(page, 'Trash').click({ button: 'right' }))
  expect(await shownMenu(page)).toEqual(['Empty Trash…'])
  await pickMenuItem(page, 'Empty Trash…')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Permanently delete 2 notes in the Trash?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(row(page, 'Trash')).toHaveText(/2$/)

  await popUp(page, () => row(page, 'Trash').click({ button: 'right' }))
  await pickMenuItem(page, 'Empty Trash…')
  await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click()
  await expect(row(page, 'Trash')).toHaveText(/0$/)
})

test('the row-menu key opens the Trash row menu', async ({ page }) => {
  await createNote(page, 'One')
  await trashOpenNote(page)
  await row(page, 'Trash').focus()
  await popUp(page, () => page.keyboard.press('Shift+F10'))
  expect(await shownMenu(page)).toEqual(['Empty Trash…'])
})

test('a Trash list row offers Restore and Delete Permanently', async ({ page }) => {
  await createNote(page, 'Keep')
  await trashOpenNote(page)
  await createNote(page, 'Goner')
  await trashOpenNote(page)
  await row(page, 'Trash').click()

  await popUp(page, () => noteRow(page, 'Keep').click({ button: 'right' }))
  expect(await labels(page)).toEqual(['Restore from Trash', '---', 'Delete Permanently'])
  await pickMenuItem(page, 'Restore from Trash')
  await expect(noteRows(page)).toHaveText([/^Goner/])
  await expect(row(page, 'Trash')).toHaveText(/1$/)

  await popUp(page, () => noteRow(page, 'Goner').click({ button: 'right' }))
  await pickMenuItem(page, 'Delete Permanently')
  await expect(page.getByRole('dialog')).toContainText('Permanently delete')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(noteRows(page)).toHaveCount(0)
})

test('on a selection, the Trash list menu acts on every selected note', async ({ page }) => {
  for (const title of ['Alpha', 'Bravo', 'Charlie']) {
    await createNote(page, title)
    await trashOpenNote(page)
  }
  await row(page, 'Trash').click()
  await noteRow(page, 'Alpha').click()
  await noteRow(page, 'Bravo').click({ modifiers: ['Meta'] })

  await popUp(page, () => noteRow(page, 'Alpha').click({ button: 'right' }))
  expect(await labels(page)).toEqual([
    'Restore Selected Notes',
    '---',
    'Delete Selected Notes Permanently',
  ])
  await pickMenuItem(page, 'Restore Selected Notes')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(row(page, 'Trash')).toHaveText(/1$/)
})

test('All Notes offers Show Notes and New Note', async ({ page }) => {
  await createNote(page, 'One')
  await row(page, 'Trash').click()
  await expect(header(page)).toHaveText('Trash')

  await popUp(page, () => row(page, 'All Notes').click({ button: 'right' }))
  expect(await labels(page)).toEqual(['Show Notes', '---', 'New Note'])
  await pickMenuItem(page, 'Show Notes')
  await expect(header(page)).toHaveText('All Notes')

  await popUp(page, () => row(page, 'All Notes').click({ button: 'right' }))
  await pickMenuItem(page, 'New Note')
  await expect(noteRows(page)).toHaveCount(2)
})

test('the Status row filters by its status from the menu, and again clears it', async ({
  page,
}) => {
  await createNote(page, 'Busy')
  await pickStatus(page, 'Active')
  await createNote(page, 'Idle')

  await popUp(page, () => row(page, 'Active').click({ button: 'right' }))
  expect(await shownMenu(page)).toEqual(['Filter by Status [ ]'])
  await pickMenuItem(page, 'Filter by Status')
  await expect(header(page)).toHaveText('Active')
  await expect(noteRows(page)).toHaveText([/^Busy/])

  await popUp(page, () => row(page, 'Active').click({ button: 'right' }))
  expect(await shownMenu(page)).toEqual(['Filter by Status [x]'])
  await pickMenuItem(page, 'Filter by Status')
  await expect(noteRows(page)).toHaveCount(2)
})

test('the Pinned row shows only pinned notes from the menu', async ({ page }) => {
  await createNote(page, 'Plain')
  await createNote(page, 'Starred')
  await pickNoteMore(page, 'Pin to Top')

  await popUp(page, () => row(page, 'Pinned').click({ button: 'right' }))
  expect(await shownMenu(page)).toEqual(['Show Pinned Notes [ ]'])
  await pickMenuItem(page, 'Show Pinned Notes')
  await expect(noteRows(page)).toHaveText([/^Starred/])
  await expect(row(page, 'Pinned')).toHaveAttribute('aria-pressed', 'true')
})
