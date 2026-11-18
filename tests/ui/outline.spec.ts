import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test, openApp } from './fixtures'

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
  await openApp(page)
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
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(entry(page, 'Intro')).toHaveAttribute('aria-current', 'location')
})

test('choosing a heading scrolls the preview too in split mode', async ({ page }) => {
  await openNoteWithHeadings(page)
  await mode(page, 'Split').click()
  await entry(page, 'Intro').click()
  await expect.poll(() => previewScroll(page)).toBeLessThan(500)
  const atIntro = await previewScroll(page)
  await entry(page, 'Ending').click()
  await expect.poll(() => previewScroll(page)).toBeGreaterThan(atIntro + 1000)
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
  await page.getByRole('button', { name: 'Focus Mode' }).click()
  await expect(outline(page)).toHaveCount(0)
})

test('resizes the inspector from the leading edge and resets it', async ({ page }) => {
  await openNoteWithHeadings(page)
  const edge = page.getByRole('separator', { name: 'Inspector' })
  const box = (await edge.boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 40, y)
  await page.mouse.up()
  await expect(edge).toHaveAttribute('aria-valuenow', '260')
  await edge.dblclick()
  await expect(edge).toHaveAttribute('aria-valuenow', '220')
  await edge.press('ArrowLeft')
  await expect(edge).toHaveAttribute('aria-valuenow', '230')
  await edge.press('Enter')
  await expect(edge).toHaveAttribute('aria-valuenow', '220')
})

test('tabs keep the outline fold and return after a narrow window expands', async ({ page }) => {
  await openNoteWithHeadings(page)
  await entry(page, 'Intro').press('ArrowLeft')
  const tab = (name: string) => page.getByRole('tab', { name, exact: true })
  await tab('Outline').press('ArrowRight')
  await expect(tab('Info')).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Info' })).toContainText('Characters')
  await tab('Info').press('End')
  await expect(tab('History')).toBeFocused()
  await tab('History').press('Home')
  await expect(entry(page, 'Intro')).toHaveAttribute('aria-expanded', 'false')
  await tab('Info').click()
  await mode(page, 'Split').click()
  await page.setViewportSize({ width: 680, height: 800 })
  await expect(tab('Info')).toBeHidden()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(tab('Info')).toHaveAttribute('aria-selected', 'true')
  await page.reload()
  await noteRows(page).first().click()
  await expect(tab('Info')).toHaveAttribute('aria-selected', 'true')
})

test('palette commands open and focus tabs and toggle the inspector', async ({ page }) => {
  await openNoteWithHeadings(page)
  const command = async (name: string) => {
    await page.keyboard.press('Meta+KeyK')
    const palette = page.getByRole('dialog', { name: 'Command Palette' })
    await palette.getByRole('combobox').fill(name)
    await palette.getByRole('option', { name: new RegExp(name) }).click()
  }
  await command('Toggle Inspector')
  await expect(outline(page)).toBeHidden()
  await command('Focus Inspector History')
  await expect(page.getByRole('tab', { name: 'History' })).toBeFocused()
  await command('Show Outline')
  await expect(outline(page)).toBeVisible()
})
