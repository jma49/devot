import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, test } from './fixtures'
import { countRenders, renderCounts, resetRenderCounts, seedNotes } from './renders'

const WATCHED = ['App', 'NoteList', 'NoteRow', 'Sidebar']

const list = (page: Page) => page.getByRole('listbox', { name: 'Notes' })
const rows = (page: Page) => list(page).getByRole('option')
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const caption = (page: Page) =>
  page.getByRole('toolbar', { name: 'Toolbar' }).first().locator('.list-count')

const row = (page: Page, title: string) =>
  rows(page).filter({ has: page.locator('.row-title', { hasText: new RegExp(`^${title}$`) }) })

async function openNote(page: Page, title: string) {
  await row(page, title).click()
  await expect(titleField(page)).toHaveValue(title)
  await body(page).click()
  await expect(body(page)).toBeFocused()
}

test('typing in a note renders neither the window nor the list nor the sidebar', async ({
  page,
}) => {
  await countRenders(page, WATCHED)
  await seedNotes(page, 50)
  await expect(caption(page)).toHaveText('50 notes')
  await openNote(page, 'Note 3')
  await resetRenderCounts(page)

  await page.keyboard.type('Typing stays in the editor')
  await expect(body(page)).toContainText('Typing stays in the editor')
  // The only renders allowed are those a save brings (the list shows the
  // note's new date then): at most one per write, never one per key.
  const { renders, writes } = await renderCounts(page)
  expect(renders['App']).toBeLessThanOrEqual(writes)
  expect(renders['NoteList']).toBeLessThanOrEqual(writes)
  expect(renders['NoteRow']).toBeLessThanOrEqual(writes)
  expect(renders['Sidebar']).toBe(0)
})

test('the preview of a split note still follows typing', async ({ page }) => {
  await seedNotes(page, 3)
  await openNote(page, 'Note 2')
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await body(page).click()
  await page.keyboard.type('# Shown live')
  await expect(page.getByRole('article', { name: 'Preview' }).locator('h1')).toHaveText(
    'Shown live',
  )
})

test('opening another note renders only the rows whose selection changed', async ({ page }) => {
  await countRenders(page, WATCHED)
  await seedNotes(page, 50)
  await expect(caption(page)).toHaveText('50 notes')
  await openNote(page, 'Note 3')
  await resetRenderCounts(page)

  await row(page, 'Note 4').click()
  await expect(titleField(page)).toHaveValue('Note 4')
  await expect(row(page, 'Note 4')).toHaveAttribute('aria-selected', 'true')
  const { renders } = await renderCounts(page)
  expect(renders['NoteRow']).toBeGreaterThanOrEqual(2)
  expect(renders['NoteRow']).toBeLessThanOrEqual(6)
  expect(renders['Sidebar']).toBe(0)
})

// Benchmark: with 10,000 notes listed, a keystroke is handled and painted
// within BUDGET_MS (median), and renders no row. BUDGET_MS is written for a
// developer's Mac; on a hosted CI runner it stretches by the shared factor
// (tests/support/budget.ts), as every other time budget does. The render
// counts below are exact on every machine and catch a re-render regression
// without depending on timing.
const NOTES = 10_000
const KEYS = 'abcdefghijklmnopqrst'
const BUDGET_MS = 30

test('with 10,000 notes a keystroke stays within its budget and renders no row', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await countRenders(page, WATCHED)
  await seedNotes(page, NOTES)
  await expect(caption(page)).toHaveText('10,000 notes', { timeout: 60_000 })
  await openNote(page, 'Note 1')
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      devotKeyMs: number[]
      addEventListener(type: string, f: () => void, capture: boolean): void
      requestAnimationFrame(f: () => void): void
      performance: { now(): number }
    }
    w.devotKeyMs = []
    w.addEventListener(
      'keydown',
      () => {
        const start = w.performance.now()
        w.requestAnimationFrame(() => w.devotKeyMs.push(w.performance.now() - start))
      },
      true,
    )
  })
  await resetRenderCounts(page)

  for (const key of KEYS) await page.keyboard.press(key)
  await expect(body(page)).toContainText(KEYS)
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as unknown as { devotKeyMs: number[] }).devotKeyMs.length),
    )
    .toBe(KEYS.length)

  const { renders, writes } = await renderCounts(page)
  expect(renders['NoteRow']).toBeLessThanOrEqual(writes)
  expect(renders['Sidebar']).toBe(0)
  const times = await page.evaluate(
    () => (globalThis as unknown as { devotKeyMs: number[] }).devotKeyMs,
  )
  const median = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]!
  const budget = BUDGET_MS * budgetScale(process.env)
  // A local machine running several suites at once cannot hold a budget; CI
  // always enforces it.
  const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
  test.skip(median >= budget && overloaded, `machine overloaded (${median.toFixed(1)} ms)`)
  expect(median).toBeLessThan(budget)
})
