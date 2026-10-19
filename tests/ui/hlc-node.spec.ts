import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Each start of the window stamps its writes (HLC timestamps) with a node ID
// of its own. Two processes never share one, even builds that share the web
// view's storage, so their timestamps never tie.

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

async function newNote(page: Page) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
}

const nodes = (page: Page) =>
  page.evaluate(() =>
    (JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as { titleHlc: string }[]).map(
      (note) => note.titleHlc.split('-')[2],
    ),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('each start of the window stamps its writes with a node ID of its own', async ({ page }) => {
  await newNote(page)
  await page.reload()
  await expect(noteRows(page)).toHaveCount(1)
  await newNote(page)
  const [first, second] = await nodes(page)
  expect(first).toMatch(/^[a-z0-9]{1,32}$/)
  expect(second).toMatch(/^[a-z0-9]{1,32}$/)
  expect(second).not.toBe(first)
  expect(await page.evaluate(() => localStorage.getItem('devot.node'))).toBeNull()
})
