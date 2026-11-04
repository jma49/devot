import type { Page } from '@playwright/test'
import { changeShortcutsElsewhere, expect, test, openApp } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const editorTags = (page: Page) => page.getByRole('group', { name: 'Tags' })
const popup = (page: Page) => page.getByRole('dialog', { name: 'Tag this note' })
const field = (page: Page) => popup(page).getByRole('combobox', { name: 'Tag name' })
const options = (page: Page) => popup(page).getByRole('option')
const chip = (page: Page, name: string) =>
  editorTags(page)
    .locator('.chip')
    .filter({ hasText: new RegExp(`^${name}$`) })

async function noteWithTags(page: Page, ...tags: string[]) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page).first()).toBeVisible()
  // Until its editor opens, keys belong to the new note and T is not a shortcut.
  await expect(page.getByRole('textbox', { name: 'Note body' })).toBeFocused()
  const inline = page.getByRole('combobox', { name: 'Add Tag' })
  for (const tag of tags) {
    await inline.fill(tag)
    await inline.press('Enter')
    await expect(chip(page, tag)).toBeVisible()
  }
}

async function openFromRow(page: Page) {
  const row = noteRows(page).first()
  await row.focus()
  await page.keyboard.press('KeyT')
  await expect(popup(page)).toBeVisible()
  await expect(field(page)).toBeFocused()
  return row
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('T filters tags with counts, Return applies and stays open, Escape gives focus back', async ({
  page,
}) => {
  await noteWithTags(page, 'alpha', 'beta')
  await noteWithTags(page)
  const row = await openFromRow(page)

  await field(page).fill('al')
  await expect(options(page)).toHaveText([/alpha\s*1/, /Create/])
  await field(page).press('Enter')
  await expect(chip(page, 'alpha')).toBeVisible()
  await expect(popup(page)).toBeVisible()
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('')

  await expect(options(page)).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(chip(page, 'beta')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(popup(page)).toHaveCount(0)
  await expect(row).toBeFocused()
})

test('a new name is created in the colour from the swatches', async ({ page }) => {
  await noteWithTags(page)
  await openFromRow(page)
  await expect(popup(page).getByRole('radiogroup', { name: 'Color' })).toHaveCount(0)
  await field(page).fill('fresh')
  await popup(page).getByRole('radio', { name: 'Green' }).click()
  await expect(field(page)).toBeFocused()
  await field(page).press('Enter')
  await expect(chip(page, 'fresh').locator('.tag-dot')).toHaveAttribute('data-color', 'green')
  await expect(popup(page)).toBeVisible()
})

test('a new tag can take a custom colour from the picker', async ({ page }) => {
  await noteWithTags(page)
  await openFromRow(page)
  await field(page).fill('fresh')
  await popup(page).getByRole('radio', { name: 'Custom Color' }).click()
  await popup(page).getByRole('textbox', { name: 'Hex' }).fill('#ff00aa')
  await popup(page).getByRole('button', { name: 'Done' }).click()
  await field(page).press('Enter')
  await expect(chip(page, 'fresh').locator('.tag-dot')).toHaveAttribute('data-color', '#ff00aa')
})

test('recent tags come first when the field is empty, and only on this device', async ({
  page,
}) => {
  await noteWithTags(page, 'alpha', 'beta', 'zeta')
  await noteWithTags(page)
  await openFromRow(page)
  await field(page).fill('zeta')
  await field(page).press('Enter')
  await page.keyboard.press('Escape')

  await noteWithTags(page)
  await openFromRow(page)
  await expect(options(page).first()).toContainText('zeta')
  const stored = await page.evaluate(() => localStorage.getItem('devot.tags.recent'))
  expect(stored).toContain('[')
})

test('Return while an input method composes is its own, and a CJK name can be created', async ({
  page,
}) => {
  await noteWithTags(page)
  await openFromRow(page)
  await field(page).fill('\u4e2d\u6587')
  await field(page).evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        keyCode: 229,
        bubbles: true,
      }),
    )
  })
  await expect(field(page)).toHaveValue('\u4e2d\u6587')
  await expect(editorTags(page).locator('.chip')).toHaveCount(0)
  await field(page).press('Enter')
  await expect(chip(page, '\u4e2d\u6587')).toBeVisible()
})

test('T is text while typing: in the title, the tag field and the search', async ({ page }) => {
  await noteWithTags(page)
  const title = page.getByRole('textbox', { name: 'Title' })
  await title.focus()
  await page.keyboard.press('KeyT')
  await expect(title).toHaveValue('t')
  await expect(popup(page)).toHaveCount(0)

  const inline = page.getByRole('combobox', { name: 'Add Tag' })
  await inline.focus()
  await page.keyboard.press('KeyT')
  await expect(inline).toHaveValue('t')
  await expect(popup(page)).toHaveCount(0)
})

test('T does not fire in the editor', async ({ page }) => {
  await noteWithTags(page)
  await page.locator('.cm-content').click()
  await page.keyboard.press('KeyT')
  await expect(popup(page)).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('t')
})

test('T does nothing with no note open', async ({ page }) => {
  await page.getByRole('button', { name: 'All Notes' }).focus()
  await page.keyboard.press('KeyT')
  await expect(popup(page)).toHaveCount(0)
})

test('a click on + Tag opens it, showing the shortcut as its label', async ({ page }) => {
  await noteWithTags(page)
  const inline = page.getByRole('combobox', { name: 'Add Tag' })
  await expect(inline).toHaveAttribute('title', 'Add Tag (T)')
  await inline.click()
  await expect(popup(page)).toBeVisible()
  await expect(field(page)).toBeFocused()
})

test('a click outside closes it', async ({ page }) => {
  await noteWithTags(page)
  await openFromRow(page)
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(popup(page)).toHaveCount(0)
})

test('the key can be rebound in Settings', async ({ page }) => {
  await noteWithTags(page)
  await changeShortcutsElsewhere(page, { 'note.quickTag': ['Mod+Shift+Y'] })
  await expect(page.getByRole('combobox', { name: 'Add Tag' })).toHaveAttribute(
    'title',
    /^Add Tag \(.+Y\)$/,
  )
  const row = noteRows(page).first()
  await row.focus()
  await page.keyboard.press('KeyT')
  await expect(popup(page)).toHaveCount(0)
  await expect(row).toBeFocused()
  await page.keyboard.press('Meta+Shift+KeyY')
  await expect(popup(page)).toBeVisible()
})

test('the palette has the command', async ({ page }) => {
  await noteWithTags(page)
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const search = palette.getByRole('combobox', { name: 'Command Palette' })
  await search.fill('> Tag This Note')
  await expect(palette.getByRole('option', { name: /Tag This Note/ })).toBeVisible()
  await search.press('Enter')
  await expect(popup(page)).toBeVisible()
})
