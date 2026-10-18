// Workspaces: a notebook opened as the whole sidebar. It shows the notebook's
// title, its notes as All Notes, its sub-notebooks, and the statuses and tags
// of its own notes; Go Up a Level goes to the parent's workspace, and out of
// workspaces at the top level.
import type { Page } from '@playwright/test'
import { expect, pickMenuItem, reloadApp, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Notebook name' })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const workspace = (page: Page, name: string) =>
  sidebar(page).getByRole('group', { name: `Workspace ${name}` })
const anyWorkspace = (page: Page) => sidebar(page).locator('.sidebar-workspace')
const allNotes = (page: Page) => sidebar(page).getByRole('button', { name: /^All Notes/ })
const count = (page: Page, label: RegExp) =>
  sidebar(page).getByRole('button', { name: label }).locator('.source-count')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await expect(nameField(page)).toHaveValue('New Notebook')
  await nameField(page).fill(name)
  await nameField(page).press('Enter')
  await expect(book(page, name)).toBeVisible()
}

/** A note in the notebook shown, with a status (2: Active) and a tag if given. */
async function createNote(page: Page, title: string, more: { active?: boolean; tag?: string }) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await titleField(page).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
  if (more.tag) {
    const tagField = page.getByRole('combobox', { name: 'Add Tag' })
    await tagField.fill(more.tag)
    await tagField.press('Enter')
    await expect(
      page.getByRole('group', { name: 'Tags' }).getByText(more.tag, { exact: true }),
    ).toBeVisible()
  }
  if (more.active) {
    await titleField(page).focus()
    await page.keyboard.press('Meta+Control+Digit2')
  }
}

/**
 * Home and Work > Devot, with notes: Chores (Home, active, #chore), Memo
 * (Work, #work) and Plan (Devot, active).
 */
async function setUp(page: Page) {
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await createBook(page, 'Devot')
  await row(page, 'Devot').dragTo(row(page, 'Work'))
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '2')
  await row(page, 'Home').click()
  await createNote(page, 'Chores', { active: true, tag: 'chore' })
  await row(page, 'Work').click()
  await createNote(page, 'Memo', { tag: 'work' })
  await row(page, 'Devot').click()
  await createNote(page, 'Plan', { active: true })
  await expect(count(page, /^Active/)).toHaveText('2')
}

async function openFromMenu(page: Page, name: string) {
  await row(page, name).click({ button: 'right' })
  await pickMenuItem(page, 'Open as Workspace')
  await expect(workspace(page, name)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('Open as Workspace shows only the notebook, with scoped counts', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  // Its sub-notebooks only; no Pinned, Templates or Trash.
  await expect(tree(page).getByRole('treeitem')).toHaveCount(1)
  await expect(book(page, 'Devot')).toBeVisible()
  for (const hidden of [/^Pinned/, /^Templates/, /^Trash/]) {
    await expect(sidebar(page).getByRole('button', { name: hidden })).toHaveCount(0)
  }
  // All Notes is the notebook with its sub-notebooks, and the counts are its own.
  await expect(header(page)).toHaveText('Work')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')
  await expect(allNotes(page).locator('.source-count')).toHaveText('2')
  await expect(noteRows(page)).toHaveCount(2)
  await expect(count(page, /^Active/)).toHaveText('1')
  // Only the tags its notes have.
  await expect(sidebar(page).getByRole('button', { name: /^work/ })).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: /^chore/ })).toHaveCount(0)
  // The sidebar has the keyboard; Backspace on All Notes goes up, out of
  // workspaces from a top-level notebook.
  await expect(allNotes(page)).toBeFocused()
  await page.keyboard.press('Backspace')
  await expect(anyWorkspace(page)).toHaveCount(0)
  await expect(tree(page).getByRole('treeitem')).toHaveCount(3)
  await expect(count(page, /^Active/)).toHaveText('2')
  await expect(header(page)).toHaveText('Work')
})

test('the palette opens a notebook as a workspace with Command+Return', async ({ page }) => {
  await setUp(page)
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('b devot')
  await expect(palette(page).getByRole('option', { name: /Devot/ })).toBeVisible()
  await page.keyboard.down('Meta')
  await expect(palette(page).locator('#palette-keys')).toContainText('Open as Workspace')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Meta')
  await expect(workspace(page, 'Devot')).toBeVisible()
  // The notebook above it shows in the title and opens as the workspace.
  await expect(
    workspace(page, 'Devot').getByRole('button', { name: 'Open Work as Workspace' }),
  ).toBeVisible()
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  await expect(noteRows(page)).toHaveText([/Plan/])
  // Command+Up goes up a level from any row, a notebook's too.
  await allNotes(page).focus()
  await page.keyboard.press('Meta+ArrowUp')
  await expect(workspace(page, 'Work')).toBeVisible()
  await row(page, 'Devot').click()
  await page.keyboard.press('Meta+ArrowUp')
  await expect(anyWorkspace(page)).toHaveCount(0)
  await expect(book(page, 'Devot')).toHaveCount(1)
})

test('the title goes up, and a parent in it opens as the workspace', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Devot')
  await workspace(page, 'Devot').getByRole('button', { name: 'Open Work as Workspace' }).click()
  await expect(workspace(page, 'Work')).toBeVisible()
  await workspace(page, 'Work').getByRole('button', { name: 'Go Up a Level' }).click()
  await expect(anyWorkspace(page)).toHaveCount(0)
})

test('a reload opens the workspace again', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  await reloadApp(page)
  await expect(workspace(page, 'Work')).toBeVisible()
  await expect(tree(page).getByRole('treeitem')).toHaveCount(1)
})

test('opening a note outside the workspace leaves it', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('Chores')
  await expect(palette(page).getByRole('option', { name: /Chores/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(titleField(page)).toHaveValue('Chores')
  await expect(anyWorkspace(page)).toHaveCount(0)
})

test('a new note made in the workspace keeps it open', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  await createNote(page, 'Fresh', {})
  await expect(workspace(page, 'Work')).toBeVisible()
  await expect(allNotes(page).locator('.source-count')).toHaveText('3')
})

test('Up from All Notes reaches the title, where Return renames the notebook', async ({ page }) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  await expect(allNotes(page)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await nameField(page).fill('Job')
  await nameField(page).press('Enter')
  await expect(workspace(page, 'Job')).toBeVisible()
})
