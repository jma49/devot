import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test, pickNoteMore } from './fixtures'

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
  await expect(
    noteRows(page).filter({ has: page.locator('.row-title', { hasText: 'Plan B' }) }),
  ).toHaveCount(1)
  await expect.poll(async () => (await body(page).textContent())?.match(LINK)?.[1]).toBe('Plan B')
  // The note being edited stays open.
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Source')
})

test('a second Return while the note is made does not make another', async ({ page }) => {
  await createNote(page, 'Source')
  // Its row shows the title once it is saved (until then, its first line).
  await expect(
    noteRows(page).filter({ has: page.locator('.row-title', { hasText: 'Source' }) }),
  ).toHaveCount(1)
  await startLink(page, 'Plan B')
  await waitForResults(page, 'Plan B')
  await page.evaluate(() => localStorage.setItem('devot.test.delayNoteWrites', '600'))
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.evaluate(() => localStorage.removeItem('devot.test.delayNoteWrites'))
  await expect.poll(async () => (await body(page).textContent()) ?? '').toMatch(LINK)
  await expect(noteRows(page)).toHaveCount(2)
  // By title: the source's excerpt shows the link's text too.
  await expect(
    noteRows(page).filter({ has: page.locator('.row-title', { hasText: 'Plan B' }) }),
  ).toHaveCount(1)
  // The link stands once; the second Return was an ordinary line break.
  expect(((await body(page).textContent()) ?? '').match(/devot:\/\/note\//g)).toHaveLength(1)
  expect(await body(page).textContent()).not.toContain('[[')
})

test('text typed while New Note is made is kept', async ({ page }) => {
  await createNote(page, 'Source')
  await startLink(page, 'Plan B')
  await waitForResults(page, 'Plan B')
  await page.evaluate(() => localStorage.setItem('devot.test.delayNoteWrites', '600'))
  await popup(page).getByRole('option', { name: 'New Note \u201cPlan B\u201d' }).click()
  await page.evaluate(() => localStorage.removeItem('devot.test.delayNoteWrites'))
  await page.keyboard.press('End')
  await page.keyboard.type(' and more')
  await expect.poll(async () => (await body(page).textContent()) ?? '').toMatch(LINK)
  expect(await body(page).textContent()).toMatch(
    /^\[Plan B\]\(devot:\/\/note\/[0-9a-f-]{36}\) and more$/,
  )
  await expect(noteRows(page)).toHaveCount(2)
})

test('a note made from the popup goes to the default notebook when the view has none', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const name = page.getByRole('textbox', { name: 'Notebook name' })
  await name.fill('Inbox')
  await name.press('Enter')
  await expect(page.getByRole('treeitem', { name: /^Inbox\b/ })).toBeVisible()
  const inbox = await page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as { id: string }[])[0]?.id ??
      '',
  )
  expect(inbox).not.toBe('')
  await changeEditorSettingsElsewhere(page, { defaultNotebook: inbox })
  await page.getByRole('button', { name: /All Notes/ }).click()
  await createNote(page, 'Source')
  await startLink(page, 'Plan B')
  await waitForResults(page, 'Plan B')
  await popup(page).getByRole('option', { name: 'New Note \u201cPlan B\u201d' }).click()
  await expect(noteRows(page)).toHaveCount(2)
  const made = () =>
    page.evaluate(
      () =>
        (
          JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
            title: string
            bookId: string | null
          }[]
        ).find((n) => n.title === 'Plan B')?.bookId ?? null,
    )
  await expect.poll(made).toBe(inbox)
})

test('no note is left unlinked when its brackets were edited meanwhile', async ({ page }) => {
  await createNote(page, 'Source')
  await startLink(page, 'Plan B')
  await waitForResults(page, 'Plan B')
  await page.evaluate(() => localStorage.setItem('devot.test.delayNoteWrites', '600'))
  await popup(page).getByRole('option', { name: 'New Note \u201cPlan B\u201d' }).click()
  await page.evaluate(() => localStorage.removeItem('devot.test.delayNoteWrites'))
  // The query is changed under the pick: the text is still the user's, no link goes in.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('!')
  // Past the time the note takes to make (and to be taken away again).
  await page.waitForTimeout(1500)
  await expect(noteRows(page)).toHaveCount(1)
  expect(await body(page).textContent()).not.toMatch(LINK)
  expect(await body(page).textContent()).toBe('[[Plan !B]]')
})

test('[[ opens no popup in code', async ({ page }) => {
  await createNote(page, 'Source')
  await body(page).click()
  await page.keyboard.type('```lua')
  // The fence's language list opens; Escape leaves the language as typed.
  await expect(popup(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Enter')
  await page.keyboard.type('local x = t[[')
  // Past the time a lookup takes: a popup in code would be showing by now.
  await page.waitForTimeout(500)
  await expect(popup(page)).toBeHidden()
  await page.keyboard.press('Enter')
  expect(await body(page).textContent()).not.toMatch(LINK)
  await expect(noteRows(page)).toHaveCount(1)
})

test('looking up notes does not save the open note', async ({ page }) => {
  await createNote(page, 'Findable')
  await createNote(page, 'Source')
  await body(page).click()
  const stored = () =>
    page.evaluate(() => {
      const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        bodyMd: string
      }[]
      return notes.find((n) => n.title === 'Source')?.bodyMd
    })
  await expect.poll(stored).toBe('')
  // Saves take 1.5 s from here: a lookup that saved first would show its
  // results only after that, and the body would be stored by then.
  await page.evaluate(() => localStorage.setItem('devot.test.delayNoteWrites', '1500'))
  await page.keyboard.type('draft [[')
  await page.keyboard.insertText('Find')
  await expect(popup(page).getByRole('option', { name: 'Findable' })).toBeVisible()
  expect(await stored()).toBe('')
  await expect.poll(stored, { timeout: 10_000 }).toContain('draft')
})

test('notes in the Trash are not offered', async ({ page }) => {
  await createNote(page, 'Old idea')
  await pickNoteMore(page, 'Move to Trash')
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

/** A note "Groceries" with a body, then "Weekly plan" linking to it, the caret after a typed word. */
async function linkedPair(page: Page) {
  await createNote(page, 'Groceries')
  await body(page).click()
  await page.keyboard.type('Milk and eggs')
  await createNote(page, 'Weekly plan')
  await startLink(page, 'Groc')
  await waitForResults(page, 'Groc')
  await page.keyboard.press('Enter')
  await expect(popup(page)).toBeHidden()
  await expect(body(page)).toContainText('devot://note/')
}

test('the caret in a note link shows Open Note, which opens it', async ({ page }) => {
  await linkedPair(page)
  // Typing hid the tooltip; moving the caret inside the link shows it.
  await page.keyboard.press('ArrowLeft')
  const tip = page.locator('.cm-link-tip')
  await expect(tip.getByRole('button', { name: 'Open Note' })).toBeVisible()
  await tip.getByRole('button', { name: 'Open Note' }).hover()
  await expect(page.locator('.cm-float-tip .cm-float-kbd')).toBeVisible()
  await tip.getByRole('button', { name: 'Open Note' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Groceries')
})

test('the caret in a web link shows Open URL, and none outside a link', async ({ page }) => {
  await createNote(page, 'Web')
  await body(page).click()
  await page.keyboard.insertText('See [docs](https://example.com/a) and more')
  await page.keyboard.press('Home')
  await expect(page.locator('.cm-link-tip')).toHaveCount(0)
  for (let n = 0; n < 6; n++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.cm-link-tip').getByRole('button', { name: 'Open URL' })).toBeVisible()
  await page.keyboard.press('End')
  await expect(page.locator('.cm-link-tip')).toHaveCount(0)
})

test('hovering a note link in the editor shows its title and excerpt', async ({ page }) => {
  await linkedPair(page)
  await page.keyboard.type(' later')
  await body(page).getByText('Groceries').hover()
  const card = page.locator('.cm-note-card-tip')
  await expect(card).toContainText('Groceries')
  await expect(card).toContainText('Milk and eggs')
})

test('hovering a note link in the preview shows its title and excerpt', async ({ page }) => {
  await linkedPair(page)
  await page.getByRole('button', { name: 'Preview' }).click()
  await page.getByRole('link', { name: 'Groceries' }).hover()
  const card = page.locator('.note-card-pop')
  await expect(card).toContainText('Groceries')
  await expect(card).toContainText('Milk and eggs')
})

test('the highlighted note of the [[ popup shows its card', async ({ page }) => {
  await createNote(page, 'Groceries')
  await body(page).click()
  await page.keyboard.type('Milk and eggs')
  await createNote(page, 'Weekly plan')
  await startLink(page, 'Groc')
  await waitForResults(page, 'Groc')
  await expect(page.locator('.cm-completionInfo')).toContainText('Milk and eggs')
})
