// Keyboard gaps of the note list and the image viewer: the list keeps a Tab
// stop when the open note is not listed, the viewer opens from the command
// palette and closes with Escape, and its Tab key goes round every stop.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const viewer = (page: Page) => page.getByRole('dialog', { name: /^Image Viewer/ })
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })

const FILE = 'devot://file/0192a6f0-0000-7000-8000-00000000f001'

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the note list keeps a Tab stop when the open note is not listed', async ({ page }) => {
  await createNote(page, 'Shown')
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Active' })
  await createNote(page, 'Hidden')
  // "Hidden" is open, and the Active filter lists only "Shown".
  await sidebar(page)
    .getByRole('button', { name: /^Active \d+$/ })
    .click()
  await expect(noteRows(page)).toHaveText([/^Shown/])
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Hidden')
  await expect(noteRows(page).first()).toHaveAttribute('tabindex', '0')
  // Tab from the sidebar row reaches it.
  await sidebar(page)
    .getByRole('button', { name: /^Active \d+$/ })
    .focus()
  await page.keyboard.press('Tab')
  await expect(noteRows(page).first()).toBeFocused()
})

test('View Image opens the viewer from the palette, and Escape closes it', async ({ page }) => {
  await createNote(page, 'Pictures')
  await body(page).click()
  await page.keyboard.insertText(`Look ![Big picture](${FILE})`)
  await page.keyboard.press('Meta+KeyP')
  await expect(field(page)).toBeFocused()
  await field(page).fill('View Image')
  const option = palette(page).getByRole('option', { name: /View Image/ })
  await expect(option).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page)).toHaveAccessibleName('Image Viewer: Big picture')
  await expect(viewer(page).locator('img')).toHaveAttribute('src', FILE)
  await expect(viewer(page).getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(body(page)).toBeFocused()
})

test('the palette offers View Image only on a line with an image', async ({ page }) => {
  await createNote(page, 'Plain')
  await body(page).click()
  await page.keyboard.insertText('No picture here')
  await page.keyboard.press('Meta+KeyP')
  await expect(field(page)).toBeFocused()
  await field(page).fill('View Image')
  await expect(palette(page).getByRole('option', { name: /View Image/ })).toHaveCount(0)
})

test('Tab and Shift+Tab go round every stop of the viewer', async ({ page }) => {
  await createNote(page, 'Pictures')
  await body(page).click()
  await page.keyboard.insertText(`![Big picture](${FILE})`)
  await page.keyboard.press('Meta+KeyP')
  await field(page).fill('View Image')
  await page.keyboard.press('Enter')
  await expect(viewer(page)).toBeVisible()
  const fit = viewer(page).getByRole('button', { name: 'Fit to Window' })
  const actual = viewer(page).getByRole('button', { name: 'Actual Size' })
  const close = viewer(page).getByRole('button', { name: 'Close' })
  const stage = viewer(page).locator('.image-viewer-stage')
  await expect(close).toBeFocused()
  // The viewer handles every Tab itself: with macOS's default keyboard
  // setting the web view would skip the buttons, or leave the dialog.
  const handled = (shiftKey: boolean) =>
    page.evaluate((shift) => {
      const w = globalThis as unknown as {
        document: { activeElement: { dispatchEvent(e: unknown): boolean } | null }
        KeyboardEvent: new (type: string, init: object) => unknown
      }
      const event = new w.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      })
      return w.document.activeElement?.dispatchEvent(event) === false
    }, shiftKey)
  expect(await handled(true)).toBe(true)
  await expect(actual).toBeFocused()
  expect(await handled(true)).toBe(true)
  await expect(fit).toBeFocused()
  expect(await handled(true)).toBe(true)
  await expect(stage).toBeFocused()
  expect(await handled(false)).toBe(true)
  await expect(fit).toBeFocused()
  expect(await handled(false)).toBe(true)
  await expect(actual).toBeFocused()
  expect(await handled(false)).toBe(true)
  await expect(close).toBeFocused()
  expect(await handled(false)).toBe(true)
  await expect(stage).toBeFocused()
  expect(await handled(false)).toBe(true)
  await expect(fit).toBeFocused()
})
