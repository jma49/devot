// Workspaces: a notebook opened as the whole sidebar; Go Up a Level goes to the parent's
// workspace, and out of workspaces at the top level.
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
 * Home and Work > Devot: Chores (Home, active, #chore), Memo (Work, #work), Plan (Devot, active).
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
  await expect(
    workspace(page, 'Devot').getByRole('button', { name: 'Open Work as Workspace' }),
  ).toBeVisible()
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  await expect(noteRows(page)).toHaveText([/Plan/])
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

const storedNotes = () =>
  JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { id: string; title: string }[]

/** The id of the note `title`, as the storage holds it. */
async function noteId(page: Page, title: string) {
  const found = (await page.evaluate(storedNotes)).find((n) => n.title === title)
  if (!found) throw new Error(`no note titled ${title}`)
  return found.id
}

/** A local HTTP API call, handed to the window as Rust hands it, as authorship.spec.ts does. */
const httpApi = (page: Page, op: string, note: string, args: Record<string, unknown>) =>
  page.evaluate(
    (call) => {
      const w = globalThis as unknown as {
        addEventListener(type: string, on: (e: { detail: { id: number } }) => void): void
        removeEventListener(type: string, on: (e: { detail: { id: number } }) => void): void
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      const id = Math.floor(Math.random() * 1e9)
      return new Promise<unknown>((resolve) => {
        const on = (e: { detail: { id: number } }) => {
          if (e.detail.id !== id) return
          w.removeEventListener('devot:http-api-done', on)
          resolve(e.detail)
        }
        w.addEventListener('devot:http-api-done', on)
        w.dispatchEvent(new w.CustomEvent('devot://http-api', { detail: { id, ...call } }))
      })
    },
    { op, note, args },
  )

test('in a workspace the Agents section counts only its notes, and filtering shows them', async ({
  page,
}) => {
  await setUp(page)
  // One write in a note the workspace holds (Memo) and one outside it (Chores).
  // The HTTP API writes only to notebooks shared with AI, so both are opened to it first.
  for (const name of ['Home', 'Work']) {
    await row(page, name).click({ button: 'right' })
    await pickMenuItem(page, 'Allow AI Access')
    await book(page, name).hover()
    await expect(book(page, name).getByRole('img', { name: 'AI access on' })).toBeVisible()
  }
  await openFromMenu(page, 'Work')
  await httpApi(page, 'notes.update', await noteId(page, 'Memo'), {
    markdown: 'Memo.\nFrom the API.\n',
  })
  await httpApi(page, 'notes.update', await noteId(page, 'Chores'), {
    markdown: 'Chores.\nFrom the API.\n',
  })
  // Only Memo is in the workspace, so the agent counts one unseen change, not the library's two (A055).
  const agent = sidebar(page).getByRole('button', { name: /^HTTP API/ })
  await expect(agent).toHaveAccessibleName('HTTP API 1 unseen change')
  await agent.click()
  await expect(noteRows(page)).toHaveText([/Memo/])
})

test('deleting the sub-notebook the workspace shows falls back to the workspace’s All Notes', async ({
  page,
}) => {
  await setUp(page)
  await openFromMenu(page, 'Work')
  await row(page, 'Devot').click()
  await expect(header(page)).toHaveText('Devot')
  await expect(noteRows(page)).toHaveText([/Plan/])

  await row(page, 'Devot').click({ button: 'right' })
  await pickMenuItem(page, 'Delete Notebook')
  await page
    .getByRole('dialog', { name: 'Delete the notebook \u201cDevot\u201d?' })
    .getByRole('button', { name: 'Delete Notebook' })
    .click()
  await expect(book(page, 'Devot')).toHaveCount(0)
  // The workspace stays: its own All Notes shows instead of dropping into the global library (A056).
  await expect(workspace(page, 'Work')).toBeVisible()
  await expect(header(page)).toHaveText('Work')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')
  await expect(noteRows(page)).toHaveText([/Memo/])
})
