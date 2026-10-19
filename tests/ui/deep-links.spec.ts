import type { Page } from '@playwright/test'
import { expect, openApp, pickNoteMore, test, type TestWindow } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const title = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const headline = (page: Page) => page.locator('.list .headline')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })
const notice = (page: Page) => page.locator('[data-devot-deep-link]')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })

const MISSING = '01890a5d-ac96-774b-bcce-b302099a8057'

async function open(page: Page, mocks: Record<string, unknown> = {}) {
  await page.addInitScript((m) => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = m
  }, mocks)
  await openApp(page)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as TestWindow).devotIpcCalls.some(
          (call) => call.cmd === 'deep_link_take',
        ),
      ),
    )
    .toBe(true)
}

const sendLink = (page: Page, link: Record<string, unknown>) =>
  page.evaluate((detail) => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:open-url', { detail }))
  }, link)

async function createNote(page: Page, name: string): Promise<string> {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(title(page)).toHaveValue('')
  await title(page).fill(name)
  const row = noteRows(page).filter({ hasText: name })
  await expect(row).toHaveCount(1)
  const id = await row.getAttribute('data-note-id')
  if (!id) throw new Error('E_TEST_NO_NOTE_ID')
  return id
}

test('a note link opens the note', async ({ page }) => {
  await open(page)
  const alpha = await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await expect(title(page)).toHaveValue('Beta')
  await sendLink(page, { kind: 'note', id: alpha })
  await expect(title(page)).toHaveValue('Alpha')
  await expect(notice(page)).toHaveCount(0)
})

test('a link to a note outside the list shown opens it in All Notes', async ({ page }) => {
  await open(page)
  const alpha = await createNote(page, 'Alpha')
  await trashRow(page).click()
  await expect(headline(page)).toHaveText('Trash')
  await sendLink(page, { kind: 'note', id: alpha })
  await expect(headline(page)).toHaveText('All Notes')
  await expect(title(page)).toHaveValue('Alpha')
})

test('a link to a note in the Trash opens it in the Trash', async ({ page }) => {
  await open(page)
  const gone = await createNote(page, 'Gone')
  await createNote(page, 'Kept')
  await noteRows(page).filter({ hasText: 'Gone' }).click()
  await pickNoteMore(page, 'Move to Trash')
  await expect(trashRow(page)).toHaveText(/1$/)
  await sendLink(page, { kind: 'note', id: gone })
  await expect(headline(page)).toHaveText('Trash')
  await expect(
    page.getByRole('status').filter({ hasText: 'This note is in the Trash.' }),
  ).toBeVisible()
})

test('a link to a note that does not exist shows a notice', async ({ page }) => {
  await open(page)
  await createNote(page, 'Alpha')
  await sendLink(page, { kind: 'note', id: MISSING })
  await expect(notice(page)).toContainText('The linked note could not be found.')
  await expect(title(page)).toHaveValue('Alpha')
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)
})

test('a command link runs an allowed command', async ({ page }) => {
  await open(page)
  await sendLink(page, { kind: 'command', id: 'view.trash' })
  await expect(headline(page)).toHaveText('Trash')
  await sendLink(page, { kind: 'command', id: 'view.allNotes' })
  await expect(headline(page)).toHaveText('All Notes')
})

test('a command that cannot run now shows a notice', async ({ page }) => {
  await open(page)
  await sendLink(page, { kind: 'command', id: 'view.edit' })
  await expect(notice(page)).toContainText('That command can’t run right now.')
})

test('links that are not allowed do nothing', async ({ page }) => {
  await open(page)
  await createNote(page, 'Alpha')
  await sendLink(page, { kind: 'command', id: 'note.trash' })
  await sendLink(page, { kind: 'note', id: 'not-an-id' })
  await sendLink(page, { kind: 'file', id: MISSING })
  // A later allowed link still runs, so the ones before were taken and refused.
  await sendLink(page, { kind: 'command', id: 'view.trash' })
  await expect(headline(page)).toHaveText('Trash')
  await expect(trashRow(page)).toHaveText(/0$/)
  await expect(notice(page)).toHaveCount(0)
})

test('a link waits while a sheet is up and runs once it closes', async ({ page }) => {
  await open(page)
  const alpha = await createNote(page, 'Alpha')
  await createNote(page, 'Beta')
  await noteRows(page).filter({ hasText: 'Beta' }).click()
  await page.keyboard.press('Meta+KeyK')
  await expect(palette(page)).toBeVisible()
  await sendLink(page, { kind: 'note', id: alpha })
  await page.waitForTimeout(100)
  await expect(title(page)).toHaveValue('Beta')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
  await expect(title(page)).toHaveValue('Alpha')
})

test('links that came before the window was ready run once it has started', async ({ page }) => {
  await open(page, { deep_link_take: [{ kind: 'command', id: 'view.trash' }] })
  await expect(headline(page)).toHaveText('Trash')
})
