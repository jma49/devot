import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete')
const LINK = /\[([^\]]*)\]\(devot:\/\/note\/[0-9a-f-]{36}\)/

// "\u540c\u6b65\u65b9\u6848" is a Chinese title ("sync plan"); "\u65b9\u6848" its second word.
const SYNC_PLAN = '\u540c\u6b65\u65b9\u6848'

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

/**
 * Waits for the results of the typed query, then past CodeMirror's
 * `interactionDelay` (75 ms), during which keys go to the editor instead.
 */
async function waitForResults(page: Page, query: string) {
  await expect(
    popup(page).getByRole('option', { name: `New Note \u201c${query}\u201d` }),
  ).toBeVisible()
  await page.waitForTimeout(150)
}

async function startLink(page: Page, query: string) {
  await body(page).click()
  await page.keyboard.type('[[')
  if (query) await page.keyboard.insertText(query)
  await expect(popup(page)).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('[[ offers other notes and inserts a standard link', async ({ page }) => {
  await createNote(page, 'Groceries')
  await createNote(page, 'Weekly plan')
  await startLink(page, '')
  // Recent notes, without the open one.
  await expect(popup(page).getByRole('option', { name: 'Groceries' })).toBeVisible()
  await expect(popup(page).getByRole('option', { name: 'Weekly plan' })).toHaveCount(0)
  await page.keyboard.insertText('groc')
  await waitForResults(page, 'groc')
  await expect(popup(page).getByRole('option').first()).toHaveText('Groceries')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toBeHidden()
  const text = (await body(page).textContent()) ?? ''
  expect(text).toMatch(LINK)
  expect(text.match(LINK)?.[1]).toBe('Groceries')
  // The brackets the editor closed are gone with the trigger.
  expect(text).not.toContain('[[')
  expect(text).not.toContain(']]')
})

test('finds notes by a Chinese title substring', async ({ page }) => {
  await createNote(page, SYNC_PLAN)
  await createNote(page, 'Linking')
  await startLink(page, '\u65b9\u6848')
  await expect(popup(page).getByRole('option', { name: SYNC_PLAN })).toBeVisible()
})

test('New Note creates the note and links it', async ({ page }) => {
  await createNote(page, 'Source')
  await startLink(page, 'Plan B')
  await popup(page).getByRole('option', { name: 'New Note “Plan B”' }).click()
  await expect(noteRows(page)).toHaveCount(2)
  await expect(noteRows(page).filter({ hasText: 'Plan B' })).toHaveCount(1)
  await expect.poll(async () => (await body(page).textContent())?.match(LINK)?.[1]).toBe('Plan B')
  // The note being edited stays open.
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Source')
})

test('notes in the Trash are not offered', async ({ page }) => {
  await createNote(page, 'Old idea')
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(noteRows(page)).toHaveCount(0)
  await createNote(page, 'Old notes index')
  await startLink(page, 'Old')
  await waitForResults(page, 'Old')
  await expect(popup(page).getByRole('option', { name: 'Old idea' })).toHaveCount(0)
})

test('a link survives renaming its target', async ({ page }) => {
  await createNote(page, 'Groceries')
  await createNote(page, 'Weekly plan')
  await startLink(page, 'Groc')
  await waitForResults(page, 'Groc')
  await expect(popup(page).getByRole('option').first()).toHaveText('Groceries')
  await page.keyboard.press('Enter')
  await expect(body(page)).toContainText('devot://note/')

  await noteRows(page).filter({ hasText: 'Groceries' }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Food')
  await noteRows(page).filter({ hasText: 'Weekly plan' }).click()
  await page.getByRole('button', { name: 'Preview' }).click()
  await page.getByRole('link', { name: 'Groceries' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Food')
})
