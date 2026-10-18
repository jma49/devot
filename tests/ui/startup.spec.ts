import type { Page } from '@playwright/test'
import { expect, test, type TestWindow } from './fixtures'

// A core that cannot start never looks like an empty library: the window
// says so, with the cause code and Try Again. Warnings the core worker
// raises reach the local log like the page's own.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const failure = (page: Page) => page.getByRole('alert').filter({ hasText: 'could not load' })
const tryAgain = (page: Page) => failure(page).getByRole('button', { name: 'Try Again' })

/** The local log lines (`log_write`) with this code: the IDs each carries. */
const logged = (page: Page, code: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === 'log_write' && call.args['code'] === c)
        .map((call) => call.args['ids']),
    code,
  )

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill(title)
  await expect(noteRows(page).filter({ hasText: title })).toHaveCount(1)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('a first load that fails says so with its code, and Try Again loads the notes', async ({
  page,
}) => {
  await page.reload()
  await createNote(page, 'Kept')
  // Stored, then gone from the page's reach: the library must not look empty.
  await expect
    .poll(() =>
      page.evaluate(() => (localStorage.getItem('devot.test.notes') ?? '').includes('Kept')),
    )
    .toBe(true)
  await page.evaluate(() => localStorage.setItem('devot.test.failList', 'E_STORAGE_BUSY'))
  await page.reload()

  await expect(failure(page)).toContainText('Devot could not load your notes.')
  await expect(failure(page)).toContainText('E_STORAGE_BUSY')
  await expect(page.getByRole('listbox', { name: 'Notes' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Sidebar' })).toHaveCount(0)
  await expect.poll(() => logged(page, 'W_CORE_START_FAILED')).toEqual([['E_STORAGE_BUSY']])

  // Still failing: Try Again shows it again, with the same code.
  await tryAgain(page).click()
  await expect(failure(page)).toContainText('E_STORAGE_BUSY')
  await expect.poll(() => logged(page, 'W_CORE_START_FAILED')).toHaveLength(2)

  await page.evaluate(() => localStorage.removeItem('devot.test.failList'))
  await tryAgain(page).click()
  await expect(failure(page)).toHaveCount(0)
  await expect(noteRows(page).filter({ hasText: 'Kept' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
})

test('a worker that does not load says so, and Try Again starts it', async ({ page }) => {
  await page.route('**/core.worker*', (route) => route.abort())
  await page.reload()
  await expect(failure(page)).toContainText('E_CORE_WORKER_FAILED')
  await expect(page.getByRole('listbox', { name: 'Notes' })).toHaveCount(0)
  await expect.poll(() => logged(page, 'W_CORE_START_FAILED')).toEqual([['E_CORE_WORKER_FAILED']])

  await page.unroute('**/core.worker*')
  await tryAgain(page).click()
  await expect(failure(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
})

test('a warning from the core worker reaches the local log by code', async ({ page }) => {
  await page.reload()
  await createNote(page, 'Warned')
  await page.evaluate(() => localStorage.setItem('devot.test.failRevisions', 'E_STORAGE_FULL'))
  // A title change is a revision event; its write fails inside the worker.
  await titleField(page).fill('Warned again')
  await expect.poll(() => logged(page, 'W_REVISION_FAILED')).toContainEqual(['E_STORAGE_FULL'])
  // Codes only: nothing of the note.
  const lines = await page.evaluate(() =>
    JSON.stringify((globalThis as unknown as TestWindow).devotIpcCalls),
  )
  expect(lines).not.toContain('Warned again')
})

test('a hidden sidebar stays out of the tab order after Try Again', async ({ page }) => {
  await page.reload()
  await page.getByRole('button', { name: 'Focus Mode' }).click()
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.evaluate(() => localStorage.setItem('devot.test.failList', 'E_STORAGE_BUSY'))
  await page.reload()
  await expect(failure(page)).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('devot.test.failList'))
  await tryAgain(page).click()
  await expect(failure(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Focus Mode' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.locator('.window > .sidebar')).toHaveAttribute('inert', '')
  await expect(page.locator('.window > .list')).toHaveAttribute('inert', '')
})
