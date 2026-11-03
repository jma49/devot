import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const outline = (page: Page) => page.getByRole('navigation', { name: 'Outline' })
const entry = (page: Page, name: string) =>
  outline(page).getByRole('treeitem').filter({ hasText: name })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })

const FILLER = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of filler text.`).join('\n\n')
const NOTE = [
  '# Intro',
  FILLER,
  '## Middle',
  FILLER,
  '### Deep part',
  FILLER,
  '# Ending',
  FILLER,
].join('\n\n')

async function openNoteWithHeadings(page: Page) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await titleField(page).fill('Long note')
  await body(page).click()
  await page.keyboard.insertText(NOTE)
}

const editorScroll = (page: Page) =>
  page
    .locator('.panes > .editor')
    .evaluate((host) => host.shadowRoot?.querySelector('.editor-scroll')?.scrollTop ?? 0)
const previewScroll = (page: Page) =>
  page.locator('.panes > .preview').evaluate((el) => el.scrollTop)

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await changeEditorSettingsElsewhere(page, { outline: true })
})

test('lists the headings nested by level', async ({ page }) => {
  await openNoteWithHeadings(page)
  await expect(outline(page).getByRole('treeitem')).toHaveCount(4)
  await expect(entry(page, 'Intro')).toHaveAttribute('aria-level', '1')
  await expect(entry(page, 'Middle')).toHaveAttribute('aria-level', '2')
  await expect(entry(page, 'Deep part')).toHaveAttribute('aria-level', '3')
})

test('choosing a heading puts the caret on it and scrolls the editor there', async ({ page }) => {
  await openNoteWithHeadings(page)
  expect(await editorScroll(page)).toBeGreaterThan(0)
  await entry(page, 'Intro').click()
  await expect.poll(() => editorScroll(page)).toBe(0)
  await entry(page, 'Ending').click()
  await expect.poll(() => editorScroll(page)).toBeGreaterThan(1000)
  await expect(entry(page, 'Ending')).toHaveAttribute('aria-current', 'location')
})

test('the heading holding the caret is marked as the caret moves', async ({ page }) => {
  await openNoteWithHeadings(page)
  await entry(page, 'Middle').click()
  await expect(entry(page, 'Middle')).toHaveAttribute('aria-current', 'location')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await expect(entry(page, 'Intro')).toHaveAttribute('aria-current', 'location')
})

test('choosing a heading scrolls the preview too in split mode', async ({ page }) => {
  await openNoteWithHeadings(page)
  await mode(page, 'Split').click()
  expect(await previewScroll(page)).toBe(0)
  await entry(page, 'Ending').click()
  await expect.poll(() => previewScroll(page)).toBeGreaterThan(1000)
})

test('arrows move, Return jumps and Escape goes back to the editor', async ({ page }) => {
  await openNoteWithHeadings(page)
  await entry(page, 'Intro').click()
  await entry(page, 'Intro').focus()
  await page.keyboard.press('ArrowDown')
  await expect(entry(page, 'Middle')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(entry(page, 'Ending')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => editorScroll(page)).toBeGreaterThan(1000)
  await page.keyboard.press('Escape')
  await expect(body(page)).toBeFocused()
})

test('a folded heading hides what is under it, and stays folded for the note', async ({ page }) => {
  await openNoteWithHeadings(page)
  await entry(page, 'Intro').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(entry(page, 'Intro')).toHaveAttribute('aria-expanded', 'false')
  await expect(entry(page, 'Middle')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(entry(page, 'Middle')).toBeVisible()
})

test('is hidden in focus mode', async ({ page }) => {
  await openNoteWithHeadings(page)
  await expect(outline(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+d')
  await expect(outline(page)).toHaveCount(0)
})
