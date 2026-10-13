import type { Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const noteRow = (page: Page, title: string) => noteRows(page).filter({ hasText: title })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const notice = (page: Page) => page.getByRole('alert')

interface StoredNote {
  title: string
  bodyMd: string
}

/** A stored note by title (what the memory adapter holds). */
const stored = (page: Page, title: string) =>
  page.evaluate((t) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[]
    return notes.find((n) => n.title === t)
  }, title)

/** The local log lines for failed saves: the IDs each one carries. */
const saveFailures = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'log_write' && c.args['code'] === 'W_NOTE_SAVE_FAILED')
      .map((c) => c.args['ids']),
  )

/** Note writes fail with `code` (a full disk, say), or work again without one. */
const failNoteWrites = (page: Page, code?: string) =>
  page.evaluate((c) => {
    if (c) localStorage.setItem('devot.test.failNoteWrites', c)
    else localStorage.removeItem('devot.test.failNoteWrites')
  }, code)

async function createNote(page: Page, title: string, text = '') {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  if (text) {
    await body(page).click()
    await page.keyboard.insertText(text)
  }
  await expect.poll(async () => (await stored(page, title))?.bodyMd).toBe(text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('changes that cannot be saved stay, are reported and are saved once writing works', async ({
  page,
}) => {
  await createNote(page, 'Kept', 'saved first')
  await createNote(page, 'Other')
  await noteRow(page, 'Kept').click()
  await expect(titleField(page)).toHaveValue('Kept')

  await failNoteWrites(page, 'E_STORAGE_SQLITE')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText(', then more')
  await expect(notice(page)).toHaveText(
    /^Changes to 1 note could not be saved \(E_STORAGE_SQLITE\)\. Devot keeps trying\./,
  )
  // Logged once, by ID and code.
  await expect
    .poll(() => saveFailures(page))
    .toEqual([[expect.stringMatching(/^[0-9a-f-]{36}$/), 'E_STORAGE_SQLITE']])
  await notice(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice(page)).toHaveCount(0)

  // Other notes still open, and another failure brings the notice back.
  await noteRow(page, 'Other').click()
  await expect(titleField(page)).toHaveValue('Other')
  await titleField(page).fill('Other, renamed')
  await expect(notice(page)).toHaveText(
    /^Changes to 2 notes could not be saved \(E_STORAGE_SQLITE\)\./,
  )
  // The unsaved changes are still there.
  await noteRow(page, 'Kept').click()
  await expect(body(page)).toHaveText('saved first, then more')
  expect((await stored(page, 'Kept'))?.bodyMd).toBe('saved first')

  await failNoteWrites(page)
  await notice(page).getByRole('button', { name: 'Try Again' }).click()
  await expect(notice(page)).toHaveCount(0)
  expect((await stored(page, 'Kept'))?.bodyMd).toBe('saved first, then more')
  expect(await stored(page, 'Other, renamed')).toBeDefined()
  await expect(noteRow(page, 'Other, renamed')).toHaveCount(1)
})

test('the window hears of a failed save before the reply of the call it failed in', async ({
  page,
}) => {
  // What a quit's save relies on: by its reply, the notice knows the notes.
  // The test starts a core of its own, to see what the window has heard
  // when the reply comes.
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeVisible()
  const heard = await page.evaluate(async (url) => {
    interface Problem {
      id: string
      code: string
    }
    interface TestCore {
      create(title: string): Promise<string>
      setTitle(id: string, title: string): Promise<void>
      flush(): Promise<void>
    }
    const { startCore } = (await import(url)) as {
      startCore(onSaveProblems: (problems: Problem[]) => void): Promise<TestCore>
    }
    const lists: Problem[][] = []
    const core = await startCore((problems) => lists.push(problems))
    const id = await core.create('Heard')
    localStorage.setItem('devot.test.failNoteWrites', 'E_STORAGE_SQLITE')
    await core.setTitle(id, 'Heard, renamed')
    return core.flush().then(
      () => 'saved',
      () => lists.map((list) => list.map((p) => `${p.id === id ? 'note' : p.id} ${p.code}`)),
    )
  }, '/src/core-client.ts')
  expect(heard).toEqual([['note E_STORAGE_SQLITE']])
})
