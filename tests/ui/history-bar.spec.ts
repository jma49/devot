import type { Page } from '@playwright/test'
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
}

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
  await expect.poll(() => savedBody(page, 'Plan')).toBe('keep oldnew end')
  await expect(slider(page)).toHaveAttribute('aria-valuemax', /^[2-9]/)

  await body(page).click()
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
