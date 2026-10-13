import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
/** A notebook's own row (its treeitem also contains its sub-notebooks). */
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('creates a notebook, selects it and files new notes there', async ({ page }) => {
  await createNote(page, 'Loose')
  await createBook(page, 'Work')
  await expect(book(page, 'Work')).toHaveAttribute('aria-selected', 'true')
  await expect(header(page)).toHaveText('Work')
  await expect(noteRows(page)).toHaveCount(0)

  await createNote(page, 'Plan')
  // Naming ended when focus moved on; the new note keeps the keyboard.
  await expect(book(page, 'Work')).not.toBeFocused()
  await expect(page.getByRole('combobox', { name: 'Notebook' })).toHaveValue(/.+/)
  await expect(book(page, 'Work')).toContainText('1')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(2)
})

test('renames with Return or a double-click; Escape cancels', async ({ page }) => {
  await createBook(page, 'Draft')
  await book(page, 'Draft').press('Enter')
  await page.getByRole('textbox', { name: 'Notebook name' }).fill('Ideas')
  await page.getByRole('textbox', { name: 'Notebook name' }).press('Enter')
  await expect(book(page, 'Ideas')).toBeVisible()

  await row(page, 'Ideas').dblclick()
  await page.getByRole('textbox', { name: 'Notebook name' }).fill('Nope')
  await page.getByRole('textbox', { name: 'Notebook name' }).press('Escape')
  await expect(book(page, 'Ideas')).toBeVisible()
  await expect(tree(page)).not.toContainText('Nope')
})

test('nests notebooks by dragging and collapses them with the arrow keys', async ({ page }) => {
  await createBook(page, 'Work')
  await createBook(page, 'Devot')
  await row(page, 'Devot').dragTo(row(page, 'Work'))
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '2')
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'true')

  await row(page, 'Work').click()
  await page.keyboard.press('ArrowDown')
  await expect(book(page, 'Devot')).toBeFocused()
  await expect(header(page)).toHaveText('Devot')
  await page.keyboard.press('ArrowLeft')
  await expect(book(page, 'Work')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(book(page, 'Work')).toHaveAttribute('aria-expanded', 'false')
  await expect(book(page, 'Devot')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(book(page, 'Devot')).toBeVisible()

  // Dropping on the section header makes it top level again.
  await row(page, 'Devot').dragTo(page.locator('.section-header', { hasText: 'Notebooks' }))
  await expect(book(page, 'Devot')).toHaveAttribute('aria-level', '1')
})

test('a notebook shows its own notes and those of its sub-notebooks', async ({ page }) => {
  await createBook(page, 'Work')
  await createNote(page, 'In Work')
  await createBook(page, 'Devot')
  await createNote(page, 'In Devot')
  await row(page, 'Devot').dragTo(row(page, 'Work'))
  await row(page, 'Work').click()
  await expect(noteRows(page)).toHaveCount(2)
  await expect(book(page, 'Work')).toContainText('2')
})

test('moves a note by dragging it onto a notebook, or with the pop-up', async ({ page }) => {
  await createNote(page, 'Wanderer')
  await createBook(page, 'Home')
  await page.getByRole('button', { name: /All Notes/ }).click()
  await noteRows(page).filter({ hasText: 'Wanderer' }).dragTo(row(page, 'Home'))
  await expect(book(page, 'Home')).toContainText('1')

  await noteRows(page).filter({ hasText: 'Wanderer' }).click()
  const picker = page.getByRole('combobox', { name: 'Notebook' })
  await picker.selectOption({ label: 'No Notebook' })
  await expect(book(page, 'Home')).toContainText('0')
})

test('deleting a notebook removes its sub-notebooks and keeps every note', async ({ page }) => {
  await createBook(page, 'Old')
  await createNote(page, 'Survivor')
  await createBook(page, 'Older')
  await row(page, 'Older').dragTo(row(page, 'Old'))
  await row(page, 'Old').click()
  await page.keyboard.press('Delete')
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0)
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page).filter({ hasText: 'Survivor' })).toHaveCount(1)
  await noteRows(page).filter({ hasText: 'Survivor' }).click()
  await expect(page.getByRole('combobox', { name: 'Notebook' })).toHaveValue('')
})

test('notebooks survive a reload', async ({ page }) => {
  await createBook(page, 'Kept')
  await createNote(page, 'Inside')
  await page.reload()
  await expect(book(page, 'Kept')).toContainText('1')
})

// The default window, and the narrowest one the note details must fit in.
for (const width of [1280, 800]) {
  test(`a 200-character notebook name is cut off in the list header and the Notebook picker (${width} px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 700 })
    const name = 'W'.repeat(200)
    await createNote(page, 'Loose')
    await createBook(page, name)

    const picker = page.getByRole('combobox', { name: 'Notebook' })
    const status = page.getByRole('combobox', { name: 'Status' })
    const box = async (locator: ReturnType<Page['locator']>) => {
      const b = await locator.boundingBox()
      if (!b) throw new Error('E_TEST_NOT_VISIBLE')
      return b
    }
    const detailsStayTight = async () => {
      const popup = page.locator('.note-meta .popup').first()
      const [p, s, content] = [
        await box(popup),
        await box(status),
        await box(page.locator('.title')),
      ]
      // The picker keeps a normal width, inside the editor, and so does Status.
      expect(p.width).toBeLessThan(300)
      expect(p.x + p.width).toBeLessThanOrEqual(content.x + content.width)
      expect(s.x + s.width).toBeLessThanOrEqual(content.x + content.width)
      // In the default window Status shares the picker's line; at 800 px the
      // row is narrower than the two, as it is for any notebook name.
      if (width === 1280) expect(Math.abs(s.y - p.y)).toBeLessThan(6)
      // Its chevron stays inside the picker.
      const chevron = await box(popup.locator('.icon').last())
      expect(chevron.x + chevron.width).toBeLessThanOrEqual(p.x + p.width + 1)
      expect(chevron.width).toBeGreaterThan(0)
      // Nothing runs out of the window or scrolls it sideways.
      expect(p.x + p.width).toBeLessThanOrEqual(width)
      const scrollWidth = await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
            .document.documentElement.scrollWidth,
      )
      expect(scrollWidth).toBeLessThanOrEqual(width)
    }

    // The note is in No Notebook; the picker is as wide as its longest option.
    await page.getByRole('button', { name: /All Notes/ }).click()
    await noteRows(page).first().click()
    await expect(picker).toHaveValue('')
    await detailsStayTight()

    // Moved into the long-named notebook, it shows its full name as a tooltip.
    await picker.selectOption({ label: name })
    await expect(picker).toHaveAttribute('title', name)
    await detailsStayTight()

    // The list header shows the name cut off, clear of the toolbar buttons.
    await book(page, 'W{200}').click()
    const headline = header(page)
    await expect(headline).toHaveText(name)
    await expect(headline).toHaveAttribute('title', name)
    await expect(headline).toHaveCSS('text-overflow', 'ellipsis')
    const [h, sort, add] = [
      await box(headline),
      await box(page.getByRole('button', { name: 'Sort Notes' })),
      await box(page.getByRole('button', { name: 'New Note', exact: true })),
    ]
    expect(h.x + h.width).toBeLessThanOrEqual(sort.x)
    expect(sort.x + sort.width).toBeLessThanOrEqual(add.x)
  })
}
