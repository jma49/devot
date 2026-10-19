// The keyboard never falls to the page: when the element that has it is
// removed, hidden or disabled, or a sheet that had it closes, it lands on a
// sensible visible element. Each test checks `document.activeElement` after
// the action. Window shortcuts use Meta (the registry's Mod matches
// metaKey everywhere).
import type { Page } from '@playwright/test'
import { expect, pickMenuItem, pickNoteMore, shownMenu, test, type TestWindow } from './fixtures'

const list = (page: Page) => page.getByRole('region', { name: 'Notes' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )?${name} \\d+$`) })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })

async function deleteFocusedBook(page: Page, name: string) {
  await page.keyboard.press('Backspace')
  await expect(
    page.getByRole('dialog', { name: `Delete the notebook \u201c${name}\u201d?` }),
  ).toBeVisible()
  await page.keyboard.press('Enter')
}

const onPage = (page: Page) =>
  page.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: { activeElement: { tagName: string } | null }
    }
    return document.activeElement === null || document.activeElement.tagName === 'BODY'
  })

async function settledFocus(page: Page) {
  await expect.poll(() => onPage(page)).toBe(false)
  return page.evaluate(() => {
    const { document } = globalThis as unknown as {
      document: { activeElement: { closest(s: string): object | null } }
    }
    const el = document.activeElement
    const area = el.closest('[data-devot-part="sidebar"]')
      ? 'sidebar'
      : el.closest('[data-devot-part="list"]')
        ? 'list'
        : el.closest('main')
          ? 'editor'
          : null
    return { part: area }
  })
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(
    noteRows(page).filter({ has: page.locator('.row-title', { hasText: title }) }),
  ).toHaveCount(1)
}

async function addTag(page: Page, name: string) {
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  await expect(tagRow(page, name)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('deleting a notebook row with the keyboard moves it to the next row', async ({ page }) => {
  for (const name of ['Home', 'Work', 'Play']) await createBook(page, name)
  await book(page, 'Work').focus()
  await deleteFocusedBook(page, 'Work')
  await expect(book(page, 'Work')).toHaveCount(0)
  await expect(book(page, 'Play')).toBeFocused()
  await deleteFocusedBook(page, 'Play')
  await expect(book(page, 'Play')).toHaveCount(0)
  await expect(book(page, 'Home')).toBeFocused()
})

test('deleting the only notebook leaves the keyboard on a sidebar row', async ({ page }) => {
  await createBook(page, 'Home')
  await book(page, 'Home').focus()
  await deleteFocusedBook(page, 'Home')
  await expect(book(page, 'Home')).toHaveCount(0)
  await expect.poll(async () => (await settledFocus(page)).part).toBe('sidebar')
})

test('deleting a tag row moves the keyboard to a neighbouring row', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'idea')
  await addTag(page, 'sync')
  await tagRow(page, 'idea').focus()
  await page.keyboard.press('Backspace')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete Tag' }).click()
  await expect(tagRow(page, 'idea')).toHaveCount(0)
  await expect(tagRow(page, 'sync')).toBeFocused()
})

test('a tag chip’s remove button hands the keyboard to the tag field', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'idea')
  await addTag(page, 'sync')
  const remove = page.getByRole('button', { name: 'Remove tag idea' })
  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(remove).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Add Tag' })).toBeFocused()
})

test('Move to Trash in the More menu leaves the keyboard in the list', async ({ page }) => {
  await createNote(page, 'First')
  await createNote(page, 'Second')
  await page.getByRole('button', { name: 'More', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await shownMenu(page)).some((l) => l.startsWith('Move to Trash')))
    .toBe(true)
  await pickMenuItem(page, 'Move to Trash')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(list(page).locator(':focus')).toHaveCount(1)
  await expect.poll(async () => (await settledFocus(page)).part).toBe('list')
})

test('Restore and Delete Permanently in the Trash leave the keyboard on a visible element', async ({
  page,
}) => {
  await createNote(page, 'Gone one')
  await createNote(page, 'Gone two')
  for (let i = 0; i < 2; i++) {
    await noteRows(page).first().click()
    await pickNoteMore(page, 'Move to Trash')
    await expect(trashRow(page)).toHaveText(new RegExp(`${i + 1}$`))
  }
  await trashRow(page).click()
  await noteRows(page).first().click()
  await expect(
    page.getByRole('status').filter({ hasText: 'This note is in the Trash.' }),
  ).toContainText('This note is in the Trash.')
  await page.getByRole('button', { name: 'Restore' }).focus()
  await page.keyboard.press('Enter')
  await expect(trashRow(page)).toHaveText(/1$/)
  await expect.poll(async () => (await settledFocus(page)).part).toBe('list')

  await noteRows(page).first().click()
  await page.getByRole('button', { name: 'Delete Permanently' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(trashRow(page)).toHaveText(/0$/)
  await expect.poll(async () => (await settledFocus(page)).part).toBe('list')
})

test('the selection summary’s actions leave the keyboard on a visible element', async ({
  page,
}) => {
  await createNote(page, 'First')
  await createNote(page, 'Second')
  await createNote(page, 'Third')
  await noteRows(page).first().click()
  await page.keyboard.press('Shift+ArrowDown')
  const summary = page.getByRole('region', { name: 'Selected Notes' })
  await expect(summary).toBeVisible()
  await summary.getByRole('button', { name: 'Move to Trash' }).focus()
  await page.keyboard.press('Enter')
  await expect(summary).toBeHidden()
  await expect.poll(async () => (await settledFocus(page)).part).toBe('list')
})

test('Empty Trash keeps the keyboard on its button, which is then disabled', async ({ page }) => {
  await createNote(page, 'Gone')
  await pickNoteMore(page, 'Move to Trash')
  await expect(trashRow(page)).toHaveText(/1$/)
  await trashRow(page).click()
  const empty = page.getByRole('button', { name: 'Empty Trash' })
  await empty.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Empty Trash' }).click()
  await expect(trashRow(page)).toHaveText(/0$/)
  await expect(empty).toBeDisabled()
  await expect(empty).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const area of ['sidebar', 'list'] as const) {
  test(`Shift+Cmd+D with the keyboard in the ${area} moves it to the editor`, async ({ page }) => {
    await createNote(page, 'Quiet')
    if (area === 'sidebar') {
      await sidebar(page)
        .getByRole('button', { name: /^All Notes/ })
        .focus()
    } else {
      await noteRows(page).first().focus()
    }
    await page.keyboard.press('Meta+Shift+KeyD')
    await expect(sidebar(page)).toBeHidden()
    await expect(list(page)).toBeHidden()
    await expect.poll(async () => (await settledFocus(page)).part).toBe('editor')
    await page.keyboard.press('Meta+Shift+KeyD')
    await expect(sidebar(page)).toBeVisible()
    await expect.poll(() => onPage(page)).toBe(false)
  })
}

test('the Backups sheet opens on Done, and closing it gives the keyboard back', async ({
  page,
}) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      backups_list: { backups: [], lastError: null },
      backup_now: null,
    }
  })
  await page.goto('/')
  await createNote(page, 'Anchor')
  const row = noteRows(page).first()
  await row.focus()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-backups'))
  })
  const dialog = page.getByRole('dialog', { name: 'Backups' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(row).toBeFocused()
  const backups = await page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter((c) => c.cmd === 'backup_now')
        .length,
  )
  expect(backups).toBe(0)
})

test('the Import sheet gives the keyboard back when it closes', async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      import_read: '# Heading\n',
      import_finish: null,
      backups_list: { backups: [], lastError: null },
    }
  })
  await page.goto('/')
  await createNote(page, 'Anchor')
  const row = noteRows(page).first()
  await row.focus()
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(
      new w.CustomEvent('devot:import-ready', {
        detail: {
          id: 3,
          name: 'Vault',
          kind: 'folder',
          files: [{ path: 'Inbox.md', bytes: 10 }],
          images: [],
          skipped: [],
        },
      }),
    )
  })
  const dialog = page.getByRole('dialog', { name: 'Import Markdown Folder' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect.poll(() => onPage(page)).toBe(false)
  await expect(page.locator(':focus')).toHaveCount(1)
})
