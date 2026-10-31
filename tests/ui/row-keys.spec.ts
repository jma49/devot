// Every notebook and tag row action has a keyboard route: Shift+F10, the menu key or Control+Return
// opens the row's native menu; window shortcuts use Meta (the registry's Mod matches metaKey everywhere).
import type { Page } from '@playwright/test'
import { expect, pickMenuItem, shownMenu, test, type TestWindow } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const bookRow = (page: Page, name: string) => book(page, name).locator('> .book-row')
const tagRow = (page: Page, name: string) =>
  sidebar(page).getByRole('button', { name: new RegExp(`^(?:[A-Z][a-z]+ )?${name} \\d+$`) })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const nameField = (page: Page, label: string) => page.getByRole('textbox', { name: label })

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await expect(nameField(page, 'Notebook name')).toHaveValue('New Notebook')
  await nameField(page, 'Notebook name').fill(name)
  await nameField(page, 'Notebook name').press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function createNoteWithTag(page: Page, title: string, tag: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  const field = page.getByRole('combobox', { name: 'Add Tag' })
  await field.fill(tag)
  await field.press('Enter')
  await expect(tagRow(page, tag)).toBeVisible()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

const popupAt = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    const popup = w.devotIpcCalls.findLast((c) => c.cmd === 'plugin:menu|popup')
    return (popup?.args['at'] as { position: { x: number; y: number } } | undefined)?.position
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

for (const keys of ['Shift+F10', 'ContextMenu', 'Control+Enter']) {
  test(`${keys} opens the menu of the focused notebook row, at the row`, async ({ page }) => {
    await createBook(page, 'Home')
    await createBook(page, 'Work')
    await book(page, 'Home').focus()
    const before = await popups(page)
    await page.keyboard.press(keys)
    await expect.poll(() => popups(page)).toBe(before + 1)
    expect(await shownMenu(page)).toContain('Allow AI Access [ ]')
    const box = await bookRow(page, 'Home').boundingBox()
    const at = await popupAt(page)
    expect(at?.x).toBeCloseTo(box?.x ?? 0, -1)
    expect(at?.y).toBeCloseTo((box?.y ?? 0) + (box?.height ?? 0), -1)
    await expect(book(page, 'Home')).toBeFocused()
  })
}

for (const keys of ['Shift+F10', 'ContextMenu', 'Control+Enter']) {
  test(`${keys} opens the menu of the focused note row, at the row`, async ({ page }) => {
    await createNote(page, 'Alpha')
    await createNote(page, 'Beta')
    await noteRows(page).filter({ hasText: 'Alpha' }).click()
    const row = noteRows(page).filter({ hasText: 'Alpha' })
    await expect(row).toBeFocused()
    const before = await popups(page)
    await page.keyboard.press(keys)
    await expect.poll(() => popups(page)).toBe(before + 1)
    expect(await shownMenu(page)).toContain('Duplicate CmdOrCtrl+D')
    const box = await row.boundingBox()
    const at = await popupAt(page)
    expect(at?.x).toBeCloseTo(box?.x ?? 0, -1)
    // Under the row: the row's own bottom, within a few pixels of its grow motion.
    expect(Math.abs((at?.y ?? 0) - ((box?.y ?? 0) + (box?.height ?? 0)))).toBeLessThan(12)
    await expect(row).toBeFocused()
  })
}

test('the row-menu key opens the selection’s menu, export included', async ({ page }) => {
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await noteRows(page).filter({ hasText: 'Alpha' }).click()
  await noteRows(page)
    .filter({ hasText: 'Beta' })
    .click({ modifiers: ['Meta'] })
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => popups(page)).toBe(1)
  const menu = await shownMenu(page)
  expect(menu.some((item) => item.startsWith('Export Selected Notes as Markdown'))).toBe(true)
  expect(menu.some((item) => item.startsWith('Copy Note Links'))).toBe(true)
})

test('Allow AI Access can be toggled from the keyboard', async ({ page }) => {
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await book(page, 'Home').focus()
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => popups(page)).toBe(1)
  await pickMenuItem(page, 'Allow AI Access')
  await bookRow(page, 'Home').hover()
  await expect(bookRow(page, 'Home').getByRole('img', { name: 'AI access on' })).toBeVisible()
  await expect(bookRow(page, 'Work').getByRole('img', { name: 'AI access on' })).toHaveCount(0)
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => popups(page)).toBe(2)
  expect(await shownMenu(page)).toContain('Allow AI Access [x]')
  await expect(book(page, 'Home')).toBeFocused()
})

test('the menu key opens the menu of a tag row, with the Color submenu', async ({ page }) => {
  await createNoteWithTag(page, 'One', 'idea')
  await tagRow(page, 'idea').focus()
  await page.keyboard.press('Shift+F10')
  await expect.poll(() => popups(page)).toBe(1)
  expect(await shownMenu(page)).toContain('Color >')
  await pickMenuItem(page, 'Purple', 'Color')
  await expect(sidebar(page).getByRole('img', { name: 'Purple' })).toBeVisible()
  await expect(tagRow(page, 'idea')).toBeFocused()
  await sidebar(page)
    .getByRole('button', { name: /^Templates/ })
    .focus()
  await page.keyboard.press('Shift+F10')
  await page.waitForTimeout(200)
  expect(await popups(page)).toBe(1)
})

test('Option+Up and Option+Down move the focused notebook among its siblings', async ({ page }) => {
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await createBook(page, 'Play')
  const names = () => tree(page).getByRole('treeitem').locator('> .book-row .source-label')
  await expect(names()).toHaveText(['Home', 'Work', 'Play'])
  await book(page, 'Work').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(names()).toHaveText(['Home', 'Play', 'Work'])
  await expect(book(page, 'Work')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(names()).toHaveText(['Home', 'Work', 'Play'])
  await expect(book(page, 'Work')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(names()).toHaveText(['Work', 'Home', 'Play'])
  await expect(book(page, 'Work')).toBeFocused()
})

test('F2 renames the focused tag, and the keyboard goes back to its row', async ({ page }) => {
  await createNoteWithTag(page, 'One', 'idea')
  await tagRow(page, 'idea').focus()
  await page.keyboard.press('F2')
  await expect(nameField(page, 'Tag name')).toBeFocused()
  await nameField(page, 'Tag name').fill('plan')
  await nameField(page, 'Tag name').press('Enter')
  await expect(tagRow(page, 'plan')).toBeFocused()
  await page.keyboard.press('F2')
  await expect(nameField(page, 'Tag name')).toBeFocused()
  await nameField(page, 'Tag name').press('Escape')
  await expect(tagRow(page, 'plan')).toBeFocused()
})

test('F2 renames the focused notebook like Return', async ({ page }) => {
  await createBook(page, 'Home')
  await book(page, 'Home').focus()
  await page.keyboard.press('F2')
  await expect(nameField(page, 'Notebook name')).toBeFocused()
  await nameField(page, 'Notebook name').press('Escape')
  await expect(book(page, 'Home')).toBeFocused()
})
