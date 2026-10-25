import type { Locator, Page } from '@playwright/test'
import * as Y from 'yjs'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

interface StoredNote {
  id: string
  title: string
  bodyMd: string
  ydoc: number[]
  bodyVersion?: number
}

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const bar = (page: Page) => page.getByRole('group', { name: 'History' })
const slider = (page: Page) => bar(page).getByRole('slider', { name: 'Version shown' })
const overlay = (page: Page) => page.getByRole('region', { name: /^The note as it was on / })
const editorPane = (page: Page) => page.locator('.panes > .editor')
const previewPane = (page: Page) => page.locator('.panes > .preview')
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })

const storedNotes = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[])
const savedBody = async (page: Page, title: string) =>
  (await storedNotes(page)).find((n) => n.title === title)?.bodyMd

async function createNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await titleField(page).fill(title)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(() => savedBody(page, title)).toBe(text)
}

/** A note whose kept version reads `before` and whose text is now `after`. */
async function noteWithHistory(page: Page, title: string, before: string, after: string) {
  await createNote(page, title, before)
  // A fresh session: the saved text is the version before the next edit.
  await page.reload()
  await noteRow(page, title).click()
  await expect(titleField(page)).toHaveValue(title)
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(after)
  await expect.poll(() => savedBody(page, title)).toBe(after)
}

async function showOldest(page: Page) {
  // The versions are read once the bar shows.
  await expect(slider(page)).not.toHaveAttribute('aria-valuemax', '0')
  await slider(page).focus()
  await page.keyboard.press('Home')
  await expect(overlay(page)).toBeVisible()
}

async function boxOf(locator: Locator) {
  const found = await locator.boundingBox()
  if (!found) throw new Error('not shown')
  return found
}

/** Nothing paints over the middle of `locator`. */
const uncovered = (locator: Locator) =>
  locator.evaluate((el: HTMLElement) => {
    // The label takes no pointer events, which hit testing would skip.
    el.style.pointerEvents = 'auto'
    const box = el.getBoundingClientRect()
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    el.style.pointerEvents = ''
    return top !== null && el.contains(top)
  })

async function selectStruck(page: Page) {
  await overlay(page)
    .locator('del')
    .first()
    .evaluate((del) => {
      const range = document.createRange()
      range.selectNodeContents(del)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('is off until View > Show History Bar turns it on', async ({ page }) => {
  await createNote(page, 'Plan', 'text')
  await expect(bar(page)).toHaveCount(0)
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await expect(bar(page)).toBeVisible()
  await changeEditorSettingsElsewhere(page, { historyBar: false })
  await expect(bar(page)).toHaveCount(0)
})

test('shows a version in place without changing the note, and Escape returns', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await expect(slider(page)).toHaveAttribute('aria-valuetext', 'Current text')

  await showOldest(page)
  await expect(overlay(page)).toBeVisible()
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /Earliest version/)
  await expect(slider(page)).toHaveAttribute('aria-valuenow', '0')
  await expect(overlay(page).locator('del')).toHaveText(['old'])
  await expect(overlay(page).locator('ins')).toHaveText(['new'])
  await expect(slider(page).locator('.history-handle-date')).toBeVisible()
  expect(await uncovered(slider(page).locator('.history-handle-date'))).toBe(true)
  await expect(bar(page).locator('.history-bar-note')).toHaveText(
    'Press Escape or End to return to the current text.',
  )
  expect(await savedBody(page, 'Plan')).toBe('keep new end')

  await page.keyboard.press('Escape')
  await expect(overlay(page)).toHaveCount(0)
  await expect(slider(page)).toHaveAttribute('aria-valuetext', 'Current text')
  await expect(body(page)).toHaveText('keep new end')
})

test('dragging the handle shows versions while held, and letting go returns', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await expect(slider(page)).not.toHaveAttribute('aria-valuemax', '0')
  const track = bar(page).locator('.history-track')
  const box = await track.boundingBox()
  if (!box) throw new Error('no track')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 1, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 1, y, { steps: 5 })
  await expect(overlay(page)).toBeVisible()
  await expect(overlay(page).locator('del')).toHaveText(['old'])
  await page.mouse.up()
  await expect(overlay(page)).toHaveCount(0)
  await expect(body(page)).toHaveText('keep new end')
})

test('an outside change shows under the version shown', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await expect(overlay(page).locator('ins')).toHaveText(['new'])

  const notes = await storedNotes(page)
  const note = notes.find((n) => n.title === 'Plan')
  if (!note) throw new Error('no note')
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(note.ydoc))
  doc.getText('body').insert(0, 'Hello ')
  note.ydoc = Array.from(Y.encodeStateAsUpdate(doc))
  note.bodyMd = doc.getText('body').toString()
  note.bodyVersion = (note.bodyVersion ?? 0) + 1
  await page.evaluate((all) => localStorage.setItem('devot.test.notes', JSON.stringify(all)), notes)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('devot:db-changed')))

  await expect(overlay(page).locator('ins')).toHaveText(['Hello ', 'new'])
  await expect(overlay(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(body(page)).toHaveText('Hello keep new end')
})

test('Restore This Passage puts struck text back as one undo step', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await expect(overlay(page).locator('del')).toHaveText(['old'])
  const restorePassage = bar(page).getByRole('button', { name: 'Restore This Passage' })
  await expect(restorePassage).toHaveCount(0)
  await expect(bar(page).getByRole('button', { name: 'Restore Whole Version' })).toBeVisible()

  await selectStruck(page)
  await restorePassage.click()
  await expect(overlay(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep old new end')
  await expect(slider(page)).toHaveAttribute('aria-valuemax', /^[2-9]/)

  await expect(page.locator('.cm-content')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep new end')
})

test('Restore Whole Version makes the note that version again', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await bar(page).getByRole('button', { name: 'Restore Whole Version' }).click()
  await expect(overlay(page)).toHaveCount(0)
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep old end')
  await expect(page.locator('.cm-content')).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep new end')
})

test('a version kept shown is put away when another note opens', async ({ page }) => {
  await createNote(page, 'Other', 'other text')
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await expect(overlay(page)).toBeVisible()
  await noteRow(page, 'Other').click()
  await expect(titleField(page)).toHaveValue('Other')
  await noteRow(page, 'Plan').click()
  await expect(titleField(page)).toHaveValue('Plan')
  await expect(overlay(page)).toHaveCount(0)
  await expect(slider(page)).toHaveAttribute('aria-valuetext', 'Current text')
  await expect(editorPane(page)).not.toHaveAttribute('inert')
  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('!')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep new end!')
})

test('Control+Tab moves on from the editor to the slider, and on to the sidebar', async ({
  page,
}) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await body(page).click()
  await page.keyboard.press('Control+Tab')
  await expect(slider(page)).toBeFocused()
  await page.keyboard.press('Control+Tab')
  await expect(
    page.locator('[data-devot-part="sidebar"] [data-sidebar-row][tabindex="0"]'),
  ).toBeFocused()
  await page.keyboard.press('Control+Shift+Tab')
  await expect(slider(page)).toBeFocused()
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.locator('.cm-content')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(slider(page)).toBeFocused()
})

test('a version that rewrote words says how many characters it changed', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await page.reload()
  await noteRow(page, 'Plan').click()
  await body(page).click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('.')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep new end.')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await page.keyboard.press('ArrowRight')
  await expect(slider(page)).toHaveAttribute('aria-valuetext', /6 characters changed$/)
})

test('each row shows its last 14 days, hidden in Settings', async ({ page }) => {
  await createNote(page, 'Plan', 'some text')
  const strip = noteRow(page, 'Plan').getByRole('img', { name: /^Last 14 days: / })
  await expect(strip).toHaveAccessibleName('Last 14 days: 1 active day')
  await expect(strip.locator('.activity-strip-day')).toHaveCount(14)
  await expect(strip.locator('.activity-strip-day').last()).toHaveClass(/activity-level-[1-4]/)
  await changeEditorSettingsElsewhere(page, { activityStrip: false })
  await expect(strip).toHaveCount(0)
})

test('the version shown lies exactly over the editor, and over both panes in split view', async ({
  page,
}) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  const editorBefore = await boxOf(editorPane(page))
  await showOldest(page)
  await expect(overlay(page)).toBeVisible()
  expect(await boxOf(overlay(page))).toEqual(await boxOf(editorPane(page)))
  expect(await boxOf(editorPane(page))).toEqual(editorBefore)
  await expect(editorPane(page)).toHaveAttribute('inert')

  await page.keyboard.press('Escape')
  await mode(page, 'Split').click()
  await showOldest(page)
  const shown = await boxOf(overlay(page))
  const editor = await boxOf(editorPane(page))
  const preview = await boxOf(previewPane(page))
  expect(shown.y).toBe(editor.y)
  expect(preview.y).toBe(editor.y)
  expect(shown.x).toBe(editor.x)
  expect(shown.x + shown.width).toBe(preview.x + preview.width)
  expect(shown.height).toBe(editor.height)
  await expect(previewPane(page)).toHaveAttribute('inert')
  await page.keyboard.press('Escape')
  await expect(editorPane(page)).not.toHaveAttribute('inert')
})

test('Escape in the palette closes the palette and leaves the version shown', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await page.keyboard.press('Meta+KeyK')
  await expect(paletteField(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await expect(overlay(page)).toBeVisible()
})

test('a struck passage can be restored from the keyboard alone', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  await page.keyboard.press('Shift+Tab')
  await expect(overlay(page).locator('del')).toBeFocused()
  const restorePassage = bar(page).getByRole('button', { name: 'Restore This Passage' })
  await expect(restorePassage).toBeVisible()
  await page.keyboard.press('Shift+Tab')
  await expect(overlay(page)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(overlay(page).locator('del')).toBeFocused()
  await expect(restorePassage).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(slider(page)).toBeFocused()
  // macOS tabs to buttons with Option (or with Full Keyboard Access).
  await page.keyboard.press('Alt+Tab')
  await expect(restorePassage).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep old new end')
})

test('the date on the handle stays inside the bar at either end', async ({ page }) => {
  await noteWithHistory(page, 'Plan', 'keep old end', 'keep new end')
  await changeEditorSettingsElsewhere(page, { historyBar: true })
  await showOldest(page)
  const date = slider(page).locator('.history-handle-date')
  const barBox = await boxOf(bar(page))
  const oldest = await boxOf(date)
  expect(oldest.x).toBeGreaterThanOrEqual(barBox.x)
  expect(oldest.x + oldest.width).toBeLessThanOrEqual(barBox.x + barBox.width)
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  const newest = await boxOf(date)
  expect(newest.x + newest.width).toBeLessThanOrEqual(barBox.x + barBox.width)
})

test('the palette shows and hides the bar, named for what it will do', async ({ page }) => {
  await createNote(page, 'Plan', 'text')
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('history bar')
  await palette(page)
    .getByRole('option', { name: /Show History Bar/ })
    .click()
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('history bar')
  await palette(page)
    .getByRole('option', { name: /Hide History Bar/ })
    .click()
  await expect(bar(page)).toHaveCount(0)
})
