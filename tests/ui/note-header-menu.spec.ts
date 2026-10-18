import type { Page } from '@playwright/test'
import { clipboardWrites, expect, pickMenuItem, shownMenu, test, type TestWindow } from './fixtures'

// The note header's native menus: a tag chip's and the notebook label's.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const editorTags = (page: Page) => page.getByRole('group', { name: 'Tags' })
const chip = (page: Page, name: string) =>
  editorTags(page)
    .locator('.chip')
    .filter({ hasText: new RegExp(`^${name}$`) })
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )?${name} \\d+$`) })

interface StoredTag {
  id: string
  name: string
}
const storedTags = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.tags') ?? '[]') as StoredTag[])

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

async function newNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

async function addTag(page: Page, name: string) {
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(name)
  await field.press('Enter')
  await expect(chip(page, name)).toBeVisible()
}

async function chipMenu(page: Page, name: string) {
  const before = await popups(page)
  await chip(page, name).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a tag chip has its own menu', async ({ page }) => {
  await newNote(page, 'One')
  await addTag(page, 'sync')
  await chipMenu(page, 'sync')
  expect(await shownMenu(page)).toEqual([
    'Tag Settings…',
    'Remove Tag',
    '---',
    'Filter by Tag [ ]',
    '---',
    'Copy Tag ID',
  ])
})

test('Remove Tag takes the tag off the note, Copy Tag ID copies its ID', async ({ page }) => {
  await newNote(page, 'One')
  await addTag(page, 'sync')
  await addTag(page, 'idea')
  const [sync] = (await storedTags(page)).filter((tag) => tag.name === 'sync')

  await chipMenu(page, 'sync')
  await pickMenuItem(page, 'Copy Tag ID')
  await expect.poll(() => clipboardWrites(page)).toEqual([sync?.id])

  await chipMenu(page, 'sync')
  await pickMenuItem(page, 'Remove Tag')
  await expect(chip(page, 'sync')).toHaveCount(0)
  await expect(chip(page, 'idea')).toBeVisible()
})

test('Filter by Tag filters the list and shows checked while it does', async ({ page }) => {
  await newNote(page, 'One')
  await addTag(page, 'sync')
  await chipMenu(page, 'sync')
  await pickMenuItem(page, 'Filter by Tag')
  await expect(tagRow(page, 'sync')).toHaveAttribute('aria-pressed', 'true')
  await chipMenu(page, 'sync')
  expect(await shownMenu(page)).toContain('Filter by Tag [x]')
})

test('Tag Settings opens the tag settings dialog', async ({ page }) => {
  await newNote(page, 'One')
  await addTag(page, 'sync')
  await chipMenu(page, 'sync')
  await pickMenuItem(page, 'Tag Settings…')
  const dialog = page.getByRole('dialog', { name: 'Tag Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveValue('sync')
})

test('the notebook label has Open Notebook and Copy Notebook ID', async ({ page }) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const bookName = page.getByRole('textbox', { name: 'Notebook name' })
  await bookName.fill('Work')
  await bookName.press('Enter')
  const book = page
    .getByRole('tree', { name: 'Notebooks' })
    .getByRole('treeitem', { name: /^Work\b/ })
  await book.locator('> .book-row').click()
  await newNote(page, 'In work')
  // Out of the notebook's view, then back to it from the note's header.
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .click()
  await expect(book).toHaveAttribute('aria-selected', 'false')

  const before = await popups(page)
  await page.getByRole('button', { name: 'Notebook', exact: true }).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await shownMenu(page)).toEqual(['Open Notebook', '---', 'Copy Notebook ID'])
  await pickMenuItem(page, 'Open Notebook')
  await expect(book).toHaveAttribute('aria-selected', 'true')
})

test('a note without a notebook has no notebook menu', async ({ page }) => {
  await newNote(page, 'Loose')
  const before = await popups(page)
  await page.getByRole('button', { name: 'Notebook', exact: true }).click({ button: 'right' })
  await page.waitForTimeout(200)
  expect(await popups(page)).toBe(before)
})
