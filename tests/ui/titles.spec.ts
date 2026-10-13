import type { Page } from '@playwright/test'
import { expect, test, openNotePinned } from './fixtures'

// Notes with no title stay told apart in the list (their first line shows,
// the title stays empty), Return in the title goes on to the body, and
// Duplicate follows one rule: "<title> copy", with the status and tags, not
// the pin.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const rowTitles = (page: Page) => noteRows(page).locator('.row-title')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

interface StoredNote {
  id: string
  title: string
  bodyMd: string
  status: string
  pinned: boolean
}
const stored = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])

/** A new note with no title and this text in its body. */
async function untitledNote(page: Page, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await body(page).click()
  await page.keyboard.insertText(text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('notes with no title show their first line, and keep an empty title', async ({ page }) => {
  await untitledNote(page, 'Groceries for the week\nmilk')
  await untitledNote(page, '# Call the dentist\n\nbefore May')
  await expect(rowTitles(page)).toHaveText(['Call the dentist', 'Groceries for the week'])

  // The title field is still empty: the line is shown, never stored as the title.
  await expect(titleField(page)).toHaveValue('')
  await expect.poll(async () => (await stored(page)).map((n) => n.title)).toEqual(['', ''])

  // Typing on goes on changing the row once the note is saved; a real title wins.
  await titleField(page).fill('Dentist')
  await expect(rowTitles(page).first()).toHaveText('Dentist')
})

test('a note with no text at all still shows Untitled', async ({ page }) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(rowTitles(page)).toHaveText(['Untitled'])
})

test('a row follows its note when the first line is rewritten', async ({ page }) => {
  await untitledNote(page, 'First draft')
  await expect(rowTitles(page)).toHaveText(['First draft'])
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('Second draft')
  await expect(rowTitles(page)).toHaveText(['Second draft'])
})

test('selecting several notes lists each by its first line', async ({ page }) => {
  await untitledNote(page, 'Alpha idea')
  await untitledNote(page, 'Beta idea')
  await noteRows(page).first().click()
  await noteRows(page)
    .last()
    .click({ modifiers: ['Shift'] })
  const summary = page.getByRole('region', { name: 'Selected Notes' })
  await expect(summary.getByRole('listitem')).toHaveText(['Beta idea', 'Alpha idea'])
})

test('Return in the title moves to the body, and an input method keeps its Return', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await titleField(page).fill('Plan')
  await titleField(page).press('Enter')
  await expect(body(page)).toBeFocused()
  await expect(titleField(page)).toHaveValue('Plan')
  await page.keyboard.insertText('first words')
  await expect(body(page)).toContainText('first words')

  // The Return that picks a candidate of an input method stays in the title.
  await titleField(page).focus()
  await titleField(page).evaluate((el) => {
    const w = globalThis as unknown as {
      KeyboardEvent: new (type: string, init: object) => object
    }
    const key = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(key, 'keyCode', { value: 229 })
    el.dispatchEvent(key as Event)
  })
  await expect(titleField(page)).toBeFocused()
})

test('Duplicate titles the copy "<title> copy", keeps status and tags, and not the pin', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await titleField(page).fill('Weekly plan')
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' })
  const tags = page.getByRole('combobox', { name: 'Add Tag' })
  await tags.fill('work')
  await tags.press('Enter')
  await noteRows(page).first().click()
  await expect(noteRows(page).first()).toBeFocused()
  await page.keyboard.press('KeyP')
  await expect.poll(() => openNotePinned(page)).toBe(true)

  await page.keyboard.press('Meta+KeyD')
  await expect(titleField(page)).toHaveValue('Weekly plan copy')
  await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('active')
  await expect(page.getByRole('group', { name: 'Tags' }).getByText('work')).toBeVisible()
  await expect.poll(() => openNotePinned(page)).toBe(false)
  await expect
    .poll(async () => (await stored(page)).map((n) => [n.title, n.status, n.pinned]))
    .toEqual([
      ['Weekly plan', 'active', true],
      ['Weekly plan copy', 'active', false],
    ])
})

test('the palette and the [[ popup name untitled notes by their first line', async ({ page }) => {
  await untitledNote(page, 'Alpha idea')
  await untitledNote(page, 'Beta idea')

  // The palette lists both, and finds one by its first line.
  await page.keyboard.press('Meta+KeyP')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const notes = palette.getByRole('group', { name: 'Notes' }).getByRole('option')
  await expect(notes).toHaveText(['Beta idea', 'Alpha idea'])
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('alpha')
  await expect(notes).toHaveText(['Alpha idea'])
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  // The [[ popup of a third note lists them the same way, and links by that name.
  await untitledNote(page, 'Gamma idea')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\n[[')
  const popup = page.locator('.cm-tooltip-autocomplete')
  await expect(popup.getByRole('option', { name: 'Alpha idea' })).toBeVisible()
  await expect(popup.getByRole('option', { name: 'Beta idea' })).toBeVisible()
  await expect(popup.getByRole('option', { name: 'Untitled' })).toHaveCount(0)
  await page.waitForTimeout(150)
  await popup.getByRole('option', { name: 'Beta idea' }).click()
  await expect(body(page)).toContainText('[Beta idea](devot://note/')
})
