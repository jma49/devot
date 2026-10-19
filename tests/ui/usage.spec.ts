import type { Page } from '@playwright/test'
import { expect, reloadApp, test, type TestWindow } from './fixtures'

// The app records a few usage events through `usage_record`; none of them
// carries a title, a query or an ID.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const header = (page: Page) => page.locator('.list .headline')

const recorded = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'usage_record')
      .map((c) => c.args),
  )

async function createNote(page: Page, title: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('records note creation and searches without their text', async ({ page }) => {
  await createNote(page, 'Secret plan')
  await createNote(page, 'Secret diary')
  await expect
    .poll(() => recorded(page))
    .toEqual([
      { name: 'note.created', properties: { from: 'new_note' } },
      { name: 'note.created', properties: { from: 'new_note' } },
    ])

  await search(page).fill('secret -tag:private')
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(2)
  await expect
    .poll(async () => (await recorded(page)).filter((e) => e['name'] === 'search.run'))
    .toEqual([
      {
        name: 'search.run',
        properties: { scope: 'view', clauses: 2, results: '2-5' },
      },
    ])

  // Results that follow a change (here a new note) are not a new search.
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect
    .poll(async () => (await recorded(page)).filter((e) => e['name'] === 'note.created'))
    .toHaveLength(3)
  // Longer than the app's settle window (1 s) after the results re-run, so a
  // second count would have been recorded by now.
  await page.waitForTimeout(2000)
  const events = await recorded(page)
  expect(events.filter((e) => e['name'] === 'search.run')).toHaveLength(1)
  const text = JSON.stringify(events).toLowerCase()
  for (const content of ['secret', 'plan', 'diary', 'private']) expect(text).not.toContain(content)
})

test('a query typed key by key counts as one search', async ({ page }) => {
  await createNote(page, 'Relay design')
  await search(page).pressSequentially('relay', { delay: 200 })
  await expect(header(page)).toHaveText('Search')
  await expect(noteRows(page)).toHaveCount(1)
  const searches = async () => (await recorded(page)).filter((e) => e['name'] === 'search.run')
  const one = [{ name: 'search.run', properties: { scope: 'view', clauses: 1, results: '1' } }]
  // The count comes once the results have settled (a second after the last
  // key): poll for it instead of guessing how long a loaded machine takes.
  await expect.poll(searches).toEqual(one)
  // And no second one follows: one more settle window, then still one.
  await page.waitForTimeout(1500)
  expect(await searches()).toEqual(one)
})

test('a failed recording never gets in the way', async ({ page }) => {
  await page.evaluate(() => {
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      usage_record: { error: 'E_USAGE_OPEN_FAILED' },
    }
  })
  await createNote(page, 'Still works')
  await expect(noteRows(page)).toHaveText([/^Still works/])
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as TestWindow).devotIpcCalls
          .filter((c) => c.cmd === 'log_write')
          .map((c) => c.args['code']),
      ),
    )
    .toContain('W_USAGE_RECORD_FAILED')
})
