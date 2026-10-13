import type { Page } from '@playwright/test'
import { expect, test, statusPicker, bookPicker } from './fixtures'

// Note templates: notes in the sidebar's Templates view, kept out of the
// library, and Cmd+T (or New Note from Template... in the palette) to make
// a note from one. Window shortcuts take Meta, as the app's registry does on
// every platform.

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const templatesRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Templates \d+$/ })
const allNotesRow = (page: Page) => sidebar(page).getByRole('button', { name: /^All Notes/ })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const header = (page: Page) => page.getByRole('toolbar', { name: 'Toolbar' }).locator('.headline')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const picker = (page: Page) => page.getByRole('dialog', { name: 'New Note from Template' })
// The user's own templates; the built-in group is counted apart.
const pickerOptions = (page: Page) =>
  picker(page).locator('[role="group"]:not([aria-label="Built-in"]) [role="option"]')
const builtInOptions = (page: Page) =>
  picker(page).getByRole('group', { name: 'Built-in' }).getByRole('option')
const preview = (page: Page) => picker(page).getByRole('region', { name: 'Preview' })

/** Makes a template in the Templates view (shown first) with a title and a body. */
async function newTemplate(page: Page, title: string, text: string) {
  await templatesRow(page).click()
  await expect(header(page)).toHaveText('Templates')
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Template', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  if (text) {
    await body(page).click()
    await page.keyboard.insertText(text)
    await expect(body(page)).toContainText(text.split('\n')[0]!)
  }
}

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('tree', { name: 'Notebooks' })).toContainText(name)
}

/** Today in the page's zone, as {{date}} writes it. */
const today = (page: Page) =>
  page.evaluate(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('templates live in their own view, out of All Notes and search', async ({ page }) => {
  await expect(templatesRow(page)).toHaveText(/0$/)
  await newTemplate(page, 'Weekly kiwi', 'kiwi template body')
  await expect(templatesRow(page)).toHaveText(/1$/)
  await expect(noteRows(page)).toHaveCount(1)
  // The editor says what a template is for, instead of the notebook picker.
  await expect(
    page.getByText(/Front matter sets the title, notebook, tags and status/),
  ).toBeVisible()
  await expect(bookPicker(page)).toHaveCount(0)
  // Nor does a template take a status: the palette offers none.
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox').fill('Move to Trash')
  await expect(palette.getByRole('option', { name: /Move to Trash/ })).toHaveCount(1)
  await palette.getByRole('combobox').fill('Set Status')
  await expect(palette.getByRole('option', { name: /Set Status/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  await allNotesRow(page).click()
  await expect(header(page)).toHaveText('All Notes')
  await expect(noteRows(page)).toHaveCount(0)
  await expect(allNotesRow(page)).toHaveText(/0$/)

  await page.getByRole('searchbox', { name: 'Search notes' }).fill('kiwi')
  await expect(header(page)).toHaveText('Search Results')
  await expect(noteRows(page)).toHaveCount(0)
})

test('Cmd+T makes a note from a template, with its defaults and variables filled in', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(2026, 2, 3, 9, 5))
  await createBook(page, 'Work')
  await newTemplate(
    page,
    'Meeting',
    '---\ntitle: Meeting {{date}}\nnotebook: Work\ntags: [meeting]\nstatus: active\nlang: en\n---\n' +
      '# {{title}}\n\nAt {{time:HH:mm}} {{who}}',
  )
  const date = await today(page)
  expect(date).toBe('2026-03-03')

  await allNotesRow(page).click()
  await page.keyboard.press('Meta+KeyT')
  await expect(picker(page)).toBeVisible()
  await expect(pickerOptions(page)).toHaveText(['Meeting'])
  await expect(pickerOptions(page).first()).toHaveAttribute('aria-selected', 'true')
  // The preview shows the note it will make.
  await expect(preview(page)).toContainText(`Meeting ${date}`)
  await expect(preview(page)).toContainText('Notebook: Work')
  await expect(preview(page)).toContainText('Tags: meeting')
  await expect(preview(page)).toContainText('Status: Active')
  await expect(preview(page)).toContainText(`# Meeting ${date}`)
  await expect(preview(page)).not.toContainText('notebook:')

  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue(`Meeting ${date}`)
  await expect(body(page)).toContainText(`# Meeting ${date}`)
  await expect(body(page)).toContainText('At 09:05 {{who}}')
  await expect(body(page)).toContainText('lang: en')
  await expect(body(page)).not.toContainText('notebook:')
  await expect(body(page)).not.toContainText('status:')
  await expect(bookPicker(page)).toHaveAttribute('data-value', /.+/)
  await expect(bookPicker(page).locator('.popup-value')).toHaveText('Work')
  await expect(statusPicker(page)).toHaveAttribute('data-value', 'active')
  await expect(page.getByRole('group', { name: 'Tags' })).toContainText('meeting')
  // The new note takes the keyboard, as a new note does.
  await expect(body(page)).toBeFocused()
  // It is a note, listed in the library; the template is unchanged.
  await expect(noteRows(page).filter({ hasText: `Meeting ${date}` })).toHaveCount(1)
  await expect(templatesRow(page)).toHaveText(/1$/)
  await templatesRow(page).click()
  await noteRows(page).filter({ hasText: 'Meeting' }).click()
  await expect(body(page)).toContainText('title: Meeting {{date}}')
})

test('the picker lists recently used templates first and previews the one selected', async ({
  page,
}) => {
  await newTemplate(page, 'Beta', 'Beta body')
  await newTemplate(page, 'Gamma', 'Gamma body')
  await newTemplate(page, 'Alpha', 'Alpha body')
  await allNotesRow(page).click()

  await page.keyboard.press('Meta+KeyT')
  await expect(pickerOptions(page)).toHaveText(['Alpha', 'Beta', 'Gamma'])
  await expect(preview(page)).toContainText('Alpha body')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(pickerOptions(page).nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(preview(page)).toContainText('Gamma body')
  await picker(page).getByRole('button', { name: 'Create' }).click()
  await expect(picker(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Gamma')
  await expect(noteRows(page)).toHaveCount(1)

  await page.keyboard.press('Meta+KeyT')
  const recent = picker(page).getByRole('group', { name: 'Recently Used' })
  await expect(recent.getByRole('option')).toHaveText(['Gamma'])
  await expect(pickerOptions(page)).toHaveText(['Gamma', 'Alpha', 'Beta'])
  // Typing filters by title.
  await picker(page).getByRole('combobox', { name: 'Filter templates' }).fill('bet')
  await expect(pickerOptions(page)).toHaveText(['Beta'])
  await expect(preview(page)).toContainText('Beta body')
  // A click selects; Escape leaves without making a note.
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(1)

  // Recently used templates are remembered on this device.
  await page.reload()
  await expect(templatesRow(page)).toHaveText(/3$/)
  await page.keyboard.press('Meta+KeyT')
  await expect(pickerOptions(page)).toHaveText(['Gamma', 'Alpha', 'Beta'])
  await pickerOptions(page).filter({ hasText: 'Beta' }).click()
  await expect(pickerOptions(page).nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(preview(page)).toContainText('Beta body')
  await pickerOptions(page).filter({ hasText: 'Beta' }).dblclick()
  await expect(picker(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('Beta')
})

test('a note made while search results show opens in a list that shows it', async ({ page }) => {
  await newTemplate(page, 'Plan', 'Plan body')
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('nothing like it')
  await expect(header(page)).toHaveText('Search Results')
  await page.keyboard.press('Meta+KeyT')
  await expect(pickerOptions(page)).toHaveText(['Plan'])
  await page.keyboard.press('Enter')
  await expect(titleField(page)).toHaveValue('Plan')
  await expect(header(page)).toHaveText('All Notes')
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toHaveValue('')
  await expect(noteRows(page).filter({ hasText: 'Plan' })).toHaveAttribute('aria-selected', 'true')
})

test('the command palette offers New Note from Template', async ({ page }) => {
  await newTemplate(page, 'Daily', 'Daily body')
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox').fill('from template')
  const option = palette.getByRole('option', { name: /New Note from Template/ })
  await expect(option).toContainText('⌘T')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toBeVisible()
  await expect(pickerOptions(page)).toHaveText(['Daily'])
})

test('with no templates of your own the picker offers the built-in ones', async ({ page }) => {
  // Cmd+T works once the core is up, as New Note does.
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.keyboard.press('Meta+KeyT')
  await expect(pickerOptions(page)).toHaveCount(0)
  await expect(builtInOptions(page)).toHaveText([
    'Brainstorming',
    'Debugging',
    'Learning',
    'Planning',
    'Daily Report',
  ])
  // The instruction quote shows in the template's own preview, not in the note.
  await expect(picker(page).getByRole('button', { name: 'Create' })).toBeEnabled()
  await picker(page).getByRole('combobox', { name: 'Filter templates' }).fill('daily')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue(/^Daily Report \d{4}-\d\d-\d\d$/)
  await expect(body(page)).not.toContainText('!Instructions')
  await expect(noteRows(page)).toHaveCount(1)
})

test('built-in templates are read-only in the Templates view; Edit a Copy makes one of your own', async ({
  page,
}) => {
  await templatesRow(page).click()
  const group = page.getByRole('group', { name: 'Built-in' })
  await expect(group.getByRole('button')).toHaveCount(5)
  await group.getByRole('button', { name: 'Planning' }).click()
  await expect(page.getByRole('region', { name: 'Planning' })).toContainText('!Instructions')
  await page.getByRole('button', { name: 'Edit a Copy' }).click()
  await expect(titleField(page)).toHaveValue('Planning')
  await expect(noteRows(page)).toHaveCount(1)
  await expect(templatesRow(page)).toHaveText(/1$/)
})

test('keys that end or steer an input method composition make no note', async ({ page }) => {
  await newTemplate(page, 'Alpha', 'Alpha body')
  await newTemplate(page, 'Beta', 'Beta body')
  await allNotesRow(page).click()
  await expect(noteRows(page)).toHaveCount(0)
  await page.keyboard.press('Meta+KeyT')
  await expect(pickerOptions(page)).toHaveText(['Alpha', 'Beta'])
  const filter = picker(page).getByRole('combobox', { name: 'Filter templates' })
  await expect(filter).toBeFocused()
  // WebKit sends the Return that confirms a candidate either while composing
  // or, once the composition ended, with key code 229.
  for (const init of [
    { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 },
    { key: 'ArrowDown', keyCode: 229 },
  ]) {
    await filter.evaluate((input, keys) => {
      const Keyboard = (
        globalThis as unknown as { KeyboardEvent: new (t: string, o: object) => object }
      ).KeyboardEvent
      const event = new Keyboard('keydown', { ...keys, bubbles: true, cancelable: true })
      if ('keyCode' in keys) Object.defineProperty(event, 'keyCode', { value: keys.keyCode })
      ;(input as unknown as { dispatchEvent(e: object): void }).dispatchEvent(event)
    }, init)
  }
  await expect(picker(page)).toBeVisible()
  await expect(pickerOptions(page).first()).toHaveAttribute('aria-selected', 'true')
  await expect(noteRows(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(0)
})

test('Move to Notebook takes a template out to No Notebook', async ({ page }) => {
  await createBook(page, 'Work')
  await newTemplate(page, 'Loose', 'Loose body')
  await expect(templatesRow(page)).toHaveText(/1$/)
  await noteRows(page).filter({ hasText: 'Loose' }).click()
  await expect(noteRows(page).filter({ hasText: 'Loose' })).toBeFocused()
  await page.keyboard.press('KeyM')
  const move = page.getByRole('dialog', { name: 'Move to Notebook' })
  await expect(move).toBeVisible()
  // A template is in none of the notebooks offered, so none is marked.
  await expect(move.getByRole('option', { checked: true })).toHaveCount(0)
  await expect(move.getByRole('option', { name: 'No Notebook' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(move).toHaveCount(0)
  await expect(templatesRow(page)).toHaveText(/0$/)
  await allNotesRow(page).click()
  await expect(noteRows(page).filter({ hasText: 'Loose' })).toHaveCount(1)
})
