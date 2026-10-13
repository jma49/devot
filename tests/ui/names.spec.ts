import type { Page } from '@playwright/test'
import { expect, test, pickNoteMore } from './fixtures'

// Names as typed: tag names stay unique and a tag picked is the one used,
// name fields stop at their limits and say why a change was refused, and
// titles with `$` patterns show as typed in dialogs.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
/** A tag's filter row ("<name> <count>"), the name in its exact case. */
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const notice = (page: Page) => page.locator('.notices').getByRole('alert')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })

interface Link {
  noteId: string
  tagId: string
  present: boolean
}

/** The IDs of the tags on the note with this title (the store's, not the screen's). */
const storedTagIds = (page: Page, title: string) =>
  page.evaluate((t) => {
    const read = <T>(key: string) => JSON.parse(localStorage.getItem(key) ?? '[]') as T[]
    const note = read<{ id: string; title: string }>('devot.test.notes').find((n) => n.title === t)
    return read<Link>('devot.test.noteTags')
      .filter((l) => l.noteId === note?.id && l.present)
      .map((l) => l.tagId)
      .sort()
  }, title)

const storedTagNames = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(localStorage.getItem('devot.test.tags') ?? '[]') as { name: string }[])
      .map((t) => t.name)
      .sort(),
  )

const FIRST = '0192a6f0-0000-7000-8000-0000000000a1'
const SECOND = '0192a6f0-0000-7000-8000-0000000000a2'

/** Two tags of one name, as sync or data from before names were unique can bring. */
async function twoTodoTags(page: Page) {
  const tag = (id: string, name: string, at: number) => ({
    id,
    name,
    nameHlc: `000000000000000${at}-0000-test`,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    deletedHlc: null,
    color: null,
    colorHlc: '',
  })
  await page.evaluate(
    (tags) => localStorage.setItem('devot.test.tags', tags),
    JSON.stringify([tag(FIRST, 'todo', 1), tag(SECOND, 'Todo', 2)]),
  )
  await page.reload()
  await expect(tagRow(page, 'todo')).toBeVisible()
  await expect(tagRow(page, 'Todo')).toBeVisible()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRow(page, title)).toHaveCount(1)
}

async function addTag(page: Page, name: string) {
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  await expect(
    page.getByRole('group', { name: 'Tags' }).getByText(name, { exact: true }),
  ).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('renaming a tag onto another tag’s name is refused with a notice', async ({ page }) => {
  await createNote(page, 'One')
  await addTag(page, 'todo')
  await addTag(page, 'to-do')
  await tagRow(page, 'to-do').dblclick()
  const field = sidebar(page).getByRole('textbox', { name: 'Tag name' })
  await expect(field).toBeFocused()
  await field.fill('Todo')
  await field.press('Enter')
  await expect(notice(page)).toHaveText(/Another tag already has that name\./)
  await expect(tagRow(page, 'to-do')).toBeVisible()
  expect(await storedTagNames(page)).toEqual(['to-do', 'todo'])
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)
})

test('notes dropped on the second of two same-named tags get that tag', async ({ page }) => {
  await twoTodoTags(page)
  await createNote(page, 'Dropped')
  await noteRow(page, 'Dropped').dragTo(tagRow(page, 'Todo'))
  await expect(tagRow(page, 'Todo')).toHaveText(/1$/)
  await expect(tagRow(page, 'todo')).toHaveText(/0$/)
  expect(await storedTagIds(page, 'Dropped')).toEqual([SECOND])
})

test('the palette adds the tag picked, not another of its name', async ({ page }) => {
  await twoTodoTags(page)
  await createNote(page, 'Picked')
  await page.keyboard.press('Meta+KeyK')
  await expect(paletteField(page)).toBeFocused()
  await paletteField(page).fill('todo')
  const tags = palette(page).getByRole('group', { name: 'Tags' }).getByRole('option')
  await expect(tags).toHaveCount(2)
  await tags.filter({ hasText: /^Todo$/ }).click({ modifiers: ['Alt'] })
  await expect(palette(page)).toBeHidden()
  await expect.poll(() => storedTagIds(page, 'Picked')).toEqual([SECOND])
})

test('the tag picker adds the tag picked to the selected notes', async ({ page }) => {
  await twoTodoTags(page)
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await noteRow(page, 'Alpha').click({ modifiers: ['Meta'] })
  await expect(page.getByRole('region', { name: 'Selected Notes' })).toBeVisible()
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('Add Tag to Selected')
  await paletteField(page).press('Enter')
  const picker = page.getByRole('dialog', { name: 'Add Tag' })
  await picker
    .getByRole('option')
    .filter({ hasText: /^Todo$/ })
    .click()
  await expect(picker).toBeHidden()
  await expect.poll(() => storedTagIds(page, 'Alpha')).toEqual([SECOND])
  await expect.poll(() => storedTagIds(page, 'Beta')).toEqual([SECOND])
})

test('name fields stop at their limits, counted in characters', async ({ page }) => {
  await createNote(page, 'Limits')
  const tagField = page.getByRole('combobox', { name: 'Add Tag' })
  await tagField.fill('x'.repeat(150))
  await expect(tagField).toHaveValue('x'.repeat(100))
  await tagField.press('y')
  await expect(tagField).toHaveValue('x'.repeat(100))
  // An emoji is one character, as the core counts it.
  await tagField.fill('\u{1f600}'.repeat(120))
  await expect(tagField).toHaveValue('\u{1f600}'.repeat(100))
  await tagField.press('Enter')
  await expect(tagRow(page, '\u{1f600}'.repeat(100))).toHaveText(/1$/)

  await page.getByRole('button', { name: 'New Notebook' }).click()
  const bookField = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(bookField).toBeFocused()
  await bookField.fill('n'.repeat(250))
  await expect(bookField).toHaveValue('n'.repeat(200))
  await bookField.press('Enter')
  await expect(
    page.getByRole('tree', { name: 'Notebooks' }).getByRole('treeitem', { name: /^n{200}\b/ }),
  ).toBeVisible()
  await expect(notice(page)).toHaveCount(0)
})

const DOLLARS = "Notes on $$x$$ $& $'"

test('a title with $ patterns shows as typed in dialogs', async ({ page }) => {
  await createNote(page, 'Other')
  await createNote(page, DOLLARS)

  // The [[ popup's New Note.
  await body(page).click()
  await page.keyboard.type('[[')
  await page.keyboard.insertText(DOLLARS)
  await expect(page.getByRole('option', { name: `New Note “${DOLLARS}”` })).toBeVisible()
  await page.keyboard.press('Escape')

  // Revision History.
  await pickNoteMore(page, 'Revision History\u2026')
  const history = page.getByRole('dialog', { name: 'Revision History' })
  await expect(history).toContainText(`Versions of “${DOLLARS}”`)
  await page.keyboard.press('Escape')
  await expect(history).toBeHidden()

  // Move to Notebook (M on the note's row).
  await noteRow(page, DOLLARS).click()
  await page.keyboard.press('m')
  const move = page.getByRole('dialog', { name: 'Move to Notebook' })
  await expect(move).toContainText(`Choose a notebook for “${DOLLARS}”.`)
  await page.keyboard.press('Escape')
  await expect(move).toBeHidden()

  // Delete Permanently, from the Trash.
  await page.keyboard.press('Meta+Backspace')
  await expect(noteRows(page)).toHaveCount(1)
  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await noteRow(page, DOLLARS).click()
  await page.getByRole('button', { name: 'Delete Permanently' }).click()
  await expect(page.getByRole('dialog')).toContainText(`Permanently delete “${DOLLARS}”?`)
})
