import type { Page } from '@playwright/test'
import { expect, pickMenuItem, shownMenu, test, type TestWindow, bookPicker } from './fixtures'

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
/** A notebook's own row (the treeitem holds only the row; sub-notebooks sit beside it). */
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Notebook name' })
const confirmDelete = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Delete the notebook \u201c${name}\u201d?` })

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await expect(nameField(page)).toHaveValue('New Notebook')
  await nameField(page).fill(name)
  await nameField(page).press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

/** Home selected, so menus below act on other notebooks. */
async function setUp(page: Page) {
  await createBook(page, 'Home')
  await createBook(page, 'Work')
  await createBook(page, 'Devot')
  await row(page, 'Devot').dragTo(row(page, 'Work'))
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '2')
  await row(page, 'Home').click()
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')
}

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

async function openMenu(page: Page, name: string) {
  const before = await popups(page)
  await row(page, name).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
}

const menuCount = (page: Page) =>
  page.evaluate(
    () =>
      Object.values((globalThis as unknown as TestWindow).devotMenus).filter(
        (m) => m.kind === 'Menu',
      ).length,
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('right-click shows the native notebook menu for that notebook', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'Work')
  expect(await shownMenu(page)).toEqual([
    'Copy Notebook ID',
    'New Notebook Inside',
    '---',
    'Open as Workspace',
    '---',
    'Rename Enter',
    'Change Icon…',
    'Move Notebook…',
    'Move Up Alt+ArrowUp',
    '---',
    'Allow AI Access [ ]',
    '---',
    'Import >',
    '  Markdown Files…',
    '  Markdown Folder…',
    '  HTML Files…',
    'Export >',
    '  as Markdown…',
    '  as HTML…',
    '---',
    'Delete Notebook Backspace',
  ])
  await openMenu(page, 'Devot')
  expect(await shownMenu(page)).toEqual([
    'Copy Notebook ID',
    'New Notebook Inside',
    '---',
    'Open as Workspace',
    '---',
    'Rename Enter',
    'Change Icon…',
    'Move Notebook…',
    'Move to Top Level',
    '---',
    'Allow AI Access [ ]',
    '---',
    'Import >',
    '  Markdown Files…',
    '  Markdown Folder…',
    '  HTML Files…',
    'Export >',
    '  as Markdown…',
    '  as HTML…',
    '---',
    'Delete Notebook Backspace',
  ])
  await openMenu(page, 'Home')
  expect(await shownMenu(page)).not.toContain('Move to Top Level')
  expect(await menuCount(page)).toBe(1)
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'false')

  const prevented = await row(page, 'Work').evaluate((el) => {
    const { MouseEvent } = globalThis as unknown as {
      MouseEvent: new (type: string, init: object) => { defaultPrevented: boolean }
    }
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    ;(el as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(prevented).toBe(true)
})

test('the clicked notebook is outlined while its menu is open', async ({ page }) => {
  await setUp(page)
  // Hold the menu open until the test closes it.
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow & { closeMenu?: () => void }
    w.devotIpcMocks = {
      'plugin:menu|popup': () =>
        new Promise<null>((resolve) => {
          w.closeMenu = () => resolve(null)
        }),
    }
  })
  await openMenu(page, 'Work')
  await expect(row(page, 'Work')).toHaveClass(/menu-target/)
  await expect(row(page, 'Home')).not.toHaveClass(/menu-target/)
  await page.evaluate(() => (globalThis as unknown as { closeMenu: () => void }).closeMenu())
  await expect(row(page, 'Work')).not.toHaveClass(/menu-target/)
})

test('New Notebook Inside creates a sub-notebook of the clicked one and names it', async ({
  page,
}) => {
  await setUp(page)
  // Collapsed: the new notebook still shows, because its parent opens.
  await row(page, 'Work').locator('.disclosure').click()
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'false')
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'New Notebook Inside')
  await expect(nameField(page)).toBeFocused()
  await expect(nameField(page)).toHaveValue('New Notebook')
  await nameField(page).fill('Plans')
  await nameField(page).press('Enter')
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'true')
  await expect(book(page, 'Plans')).toHaveAttribute('aria-level', '2')
  await expect(book(page, 'Plans')).toHaveAttribute('aria-selected', 'true')
  await expect(header(page)).toHaveText('Plans')
  await expect(book(page, 'Home')).toHaveAttribute('aria-level', '1')
  await expect(book(page, 'Home')).not.toHaveAttribute('aria-expanded')
})

test('a menu opened at the centre of an expanded notebook acts on that notebook', async ({
  page,
}) => {
  await setUp(page)
  // Assistive technology presses at an element's centre: for an expanded Work that must still be Work, not Devot.
  const before = await popups(page)
  await book(page, 'Work').click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  await pickMenuItem(page, 'Rename')
  await expect(nameField(page)).toHaveValue('Work')
  // The treeitem owns its sub-notebooks without containing them.
  await expect(book(page, 'Work')).toHaveAttribute('aria-owns', /.+/)
  await expect(book(page, 'Work').getByRole('treeitem')).toHaveCount(0)
})

test('Rename names the clicked notebook, not the selected one', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'Devot')
  await pickMenuItem(page, 'Rename')
  await expect(nameField(page)).toBeFocused()
  await expect(nameField(page)).toHaveValue('Devot')
  await nameField(page).fill('Devot App')
  await nameField(page).press('Enter')
  await expect(book(page, 'Devot App')).toHaveAttribute('aria-level', '2')
  await expect(book(page, 'Home')).toBeVisible()
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')
  await expect(book(page, 'Home')).toBeFocused()
  await expect(header(page)).toHaveText('Home')
})

test('Move to Top Level moves the clicked notebook out of its parent', async ({ page }) => {
  await setUp(page)
  await openMenu(page, 'Devot')
  await pickMenuItem(page, 'Move to Top Level')
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '1')
  await expect(book(page, 'Work')).not.toHaveAttribute('aria-expanded')
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')
})

test('Delete Notebook deletes the clicked notebook with its sub-notebooks and keeps the notes', async ({
  page,
}) => {
  await setUp(page)
  await row(page, 'Devot').click()
  await createNote(page, 'Survivor')
  await row(page, 'Home').click()
  await createNote(page, 'At Home')
  await expect(header(page)).toHaveText('Home')
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Delete Notebook')
  await confirmDelete(page, 'Work').getByRole('button', { name: 'Delete Notebook' }).click()
  await expect(book(page, 'Work')).toHaveCount(0)
  await expect(book(page, 'Devot')).toHaveCount(0)
  await expect(tree(page).getByRole('treeitem')).toHaveCount(1)
  await expect(header(page)).toHaveText('Home')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await expect(noteRows(page)).toHaveCount(2)
  await noteRows(page).filter({ hasText: 'Survivor' }).click()
  await expect(bookPicker(page)).toHaveAttribute('data-value', '')
})

test('the keys still rename and delete the focused notebook', async ({ page }) => {
  await setUp(page)
  await row(page, 'Work').click()
  await page.keyboard.press('Enter')
  await nameField(page).fill('Job')
  await nameField(page).press('Enter')
  await expect(book(page, 'Job')).toBeFocused()
  await page.keyboard.press('Backspace')
  await expect(confirmDelete(page, 'Job')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(book(page, 'Job')).toHaveCount(0)
  await expect(tree(page).getByRole('treeitem')).toHaveCount(1)
})

test('the keyboard stays on the selected notebook after a right-click', async ({ page }) => {
  await setUp(page)
  await row(page, 'Home').click()
  await expect(book(page, 'Home')).toBeFocused()
  // The mock menu closes at once, with nothing picked.
  await openMenu(page, 'Work')
  await expect(book(page, 'Home')).toBeFocused()
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')
  // The keys act on the selected notebook, not on the one right-clicked.
  await page.keyboard.press('ArrowDown')
  await expect(book(page, 'Work')).toBeFocused()
  await row(page, 'Home').click()
  await openMenu(page, 'Work')
  await page.keyboard.press('Backspace')
  await expect(confirmDelete(page, 'Home')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(book(page, 'Home')).toHaveCount(0)
  await expect(book(page, 'Work')).toBeVisible()
})

test('the keyboard stays in the tree after Delete Notebook from the menu', async ({ page }) => {
  await setUp(page)
  await row(page, 'Home').click()
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Delete Notebook')
  await confirmDelete(page, 'Work').getByRole('button', { name: 'Delete Notebook' }).click()
  await expect(book(page, 'Work')).toHaveCount(0)
  await expect(book(page, 'Home')).toBeFocused()
})

test('Backspace and Delete on a notebook row ask first; Cancel and Escape keep it', async ({
  page,
}) => {
  await setUp(page)
  await row(page, 'Devot').click()
  await createNote(page, 'Survivor')
  await row(page, 'Work').click()
  await expect(book(page, 'Work')).toBeFocused()

  await page.keyboard.press('Backspace')
  const ask = confirmDelete(page, 'Work')
  await expect(ask).toContainText(
    'Its 1 sub-notebook will be deleted too. Together they hold 1 note, which will stay without a notebook.',
  )
  await expect(tree(page).getByRole('treeitem')).toHaveCount(3)
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(book(page, 'Work')).toBeFocused()
  await expect(book(page, 'Devot')).toBeVisible()

  await page.keyboard.press('Delete')
  await expect(ask).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)
  await expect(book(page, 'Work')).toBeFocused()
  await expect(tree(page).getByRole('treeitem')).toHaveCount(3)
  await expect(noteRows(page).filter({ hasText: 'Survivor' })).toHaveCount(1)

  await row(page, 'Home').click()
  await page.keyboard.press('Backspace')
  await expect(confirmDelete(page, 'Home')).toContainText('It is empty.')
  await page.keyboard.press('Escape')
  await expect(book(page, 'Home')).toBeFocused()
})

test('Delete Notebook from the menu asks too, and Cancel keeps the keyboard where it was', async ({
  page,
}) => {
  await setUp(page)
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Delete Notebook')
  const ask = confirmDelete(page, 'Work')
  await expect(ask).toContainText('Its 1 sub-notebook will be deleted too.')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(book(page, 'Work')).toBeVisible()
  await expect(book(page, 'Devot')).toBeVisible()
  await expect(book(page, 'Home')).toBeFocused()
})

test('Rename from the menu keeps the keyboard when the selected notebook is hidden', async ({
  page,
}) => {
  await setUp(page)
  await row(page, 'Devot').click()
  await expect(book(page, 'Devot')).toHaveAttribute('aria-selected', 'true')
  await row(page, 'Work').locator('.disclosure').click()
  await expect(book(page, 'Devot')).toHaveCount(0)
  await openMenu(page, 'Home')
  await pickMenuItem(page, 'Rename')
  await nameField(page).fill('House')
  await nameField(page).press('Enter')
  await expect(book(page, 'House')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(book(page, 'Work')).toBeFocused()
})

const aiBadge = (page: Page, name: string) =>
  row(page, name).getByRole('img', { name: 'AI access on' })

test('Allow AI Access switches the clicked notebook alone and shows on its row', async ({
  page,
}) => {
  await setUp(page)
  await expect(page.getByRole('img', { name: 'AI access on' })).toHaveCount(0)
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Allow AI Access')
  await expect(aiBadge(page, 'Work')).toBeVisible()
  // Not inherited: the sub-notebook keeps its own switch, off.
  await expect(aiBadge(page, 'Devot')).toHaveCount(0)
  await expect(aiBadge(page, 'Home')).toHaveCount(0)
  await expect(book(page, 'Home')).toHaveAttribute('aria-selected', 'true')

  await openMenu(page, 'Work')
  expect(await shownMenu(page)).toContain('Allow AI Access [x]')
  await openMenu(page, 'Devot')
  expect(await shownMenu(page)).toContain('Allow AI Access [ ]')
  await openMenu(page, 'Work')
  expect(await shownMenu(page)).toContain('Allow AI Access [x]')

  await page.reload()
  await expect(aiBadge(page, 'Work')).toBeVisible()

  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Allow AI Access')
  await expect(aiBadge(page, 'Work')).toHaveCount(0)
  await openMenu(page, 'Work')
  expect(await shownMenu(page)).toContain('Allow AI Access [ ]')
})

test('Move Notebook opens a dialog that lists the tree and disables the notebook and its sub-notebooks', async ({
  page,
}) => {
  await setUp(page)
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Move Notebook…')
  const dialog = page.getByRole('dialog', { name: 'Move Notebook' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('option', { name: 'Work' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(dialog.getByRole('option', { name: 'Devot' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(dialog.getByRole('option', { name: 'Home' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await dialog.getByRole('option', { name: 'Home' }).click()
  await expect(dialog).toHaveCount(0)
})

test('Move Notebook keeps the focus on Cancel through a re-render, so Return cancels', async ({
  page,
}) => {
  await setUp(page)
  await openMenu(page, 'Work')
  await pickMenuItem(page, 'Move Notebook…')
  const dialog = page.getByRole('dialog', { name: 'Move Notebook' })
  const cancel = dialog.getByRole('button', { name: 'Cancel' })
  await cancel.focus()
  await expect(cancel).toBeFocused()
  // The mouse crossing a row re-renders the dialog.
  await dialog.getByRole('option', { name: 'Top Level' }).hover()
  await expect(dialog.getByRole('option', { name: 'Top Level' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('treeitem', { name: /^Work\b/ })).toBeVisible()
  // Work is still at the top level: nothing moved into Home.
  await expect(
    page.getByRole('treeitem', { name: /^Home\b/ }).getByRole('treeitem', { name: /^Work\b/ }),
  ).toHaveCount(0)
})

test('turns Allow AI Access on for several notebooks at once, with Undo', async ({ page }) => {
  await setUp(page)
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('AI Access for Several')
  await palette.getByRole('option', { name: /AI Access for Several Notebooks/ }).click()

  const picker = page.getByRole('dialog', { name: 'Allow AI Access' })
  await expect(picker).toBeVisible()
  // Nothing is on yet, and Apply has nothing to do until a switch differs.
  await expect(picker.getByRole('checkbox')).toHaveCount(3)
  await expect(picker.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await picker.getByRole('button', { name: 'Select All' }).click()
  await expect(picker.getByRole('button', { name: 'Apply' })).toBeEnabled()
  await picker.getByRole('button', { name: 'Apply' }).click()
  await expect(picker).toHaveCount(0)

  const done = page.getByRole('status').filter({ hasText: 'notebooks now allow AI access' })
  await expect(done).toContainText('3 notebooks now allow AI access.')
  for (const name of ['Home', 'Work', 'Devot']) {
    await expect(row(page, name).getByRole('img', { name: 'AI access on' })).toBeVisible()
  }

  await done.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'AI access is off' })).toContainText(
    'AI access is off for 3 notebooks.',
  )
  await expect(page.getByRole('img', { name: 'AI access on' })).toHaveCount(0)
})
