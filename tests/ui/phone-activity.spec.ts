import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const screen = (page: Page) => page.getByRole('region', { name: 'Activity' })

/** Wednesday 7 October 2026: 100 words on the Friday before, 340 by that Monday. */
async function seed(page: Page) {
  await page.addInitScript(() => {
    const fixed = new Date(2026, 9, 7, 15).getTime()
    Date.now = () => fixed
  })
  await page.goto('/')
  await page.evaluate(() => {
    const noteId = '0192a6f0-0000-7000-8000-00000000000a'
    const created = new Date(2026, 9, 1, 9).getTime()
    localStorage.setItem(
      'devot.test.notes',
      JSON.stringify([
        {
          id: noteId,
          title: 'Sync handshake',
          titleHlc: '0000000000001-0000-test',
          bodyMd: 'hello',
          ydoc: [0, 0],
          bookId: null,
          bookHlc: '',
          status: 'none',
          statusHlc: '',
          pinned: false,
          pinnedHlc: '',
          createdAt: created,
          updatedAt: created,
          deletedAt: null,
          deletedHlc: null,
        },
      ]),
    )
    const version = (id: string, at: number, words: number) => ({
      id: `0192a6f0-0000-7000-9000-${id.padStart(12, '0')}`,
      noteId,
      kind: 'body',
      at,
      ydoc: [0, 0],
      length: words * 5,
      value: null,
      words,
    })
    localStorage.setItem(
      'devot.test.revisions',
      JSON.stringify([
        version('1', new Date(2026, 9, 2, 12).getTime(), 100),
        version('2', new Date(2026, 9, 5, 12).getTime(), 340),
      ]),
    )
  })
  await page.reload()
  await page.getByRole('button', { name: 'Activity' }).click()
  await expect(screen(page)).toBeVisible()
}

test('shows a heatmap of 15 weeks in 16 pt cells, summarised for VoiceOver', async ({ page }) => {
  await seed(page)
  const grid = screen(page).getByRole('img', {
    name: /last 15 weeks.*Words changed: 340/,
  })
  await expect(grid).toBeVisible()
  const cells = grid.locator('.phone-heat-cell')
  expect(await cells.count()).toBeGreaterThan(14 * 7)
  expect(await cells.count()).toBeLessThanOrEqual(15 * 7)
  const box = (await cells.first().boundingBox())!
  expect([box.width, box.height]).toEqual([16, 16])
  await expect(cells.last()).toHaveCSS('border-radius', '4px')
  const [right, left] = [await cells.nth(7).boundingBox(), box]
  expect(right!.x - left.x).toBeCloseTo(20, 0)
  await expect(screen(page).locator('.phone-heat-legend')).toContainText('less')
  await expect(screen(page).locator('.phone-heat-months')).toContainText('Aug')
})

test('the Week menu changes the stats and ranking, never the heatmap', async ({ page }) => {
  await seed(page)
  const stats = screen(page).locator('.phone-stat')
  await expect(stats.nth(0)).toContainText('words this week')
  await expect(stats.nth(0)).toContainText('240')
  await expect(screen(page).getByRole('region', { name: 'Most edited this week' })).toContainText(
    '+240',
  )
  const grid = screen(page).locator('.phone-heat-grid')
  const before = await grid.innerHTML()
  const capsule = screen(page).getByRole('button', { name: 'Week', exact: true })
  expect((await capsule.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await capsule.click()
  await screen(page).getByRole('menuitemradio', { name: 'Last week' }).click()
  await expect(stats.nth(0)).toContainText('words last week')
  await expect(stats.nth(0)).toContainText('100')
  await expect(screen(page).getByRole('region', { name: 'Most edited last week' })).toContainText(
    '+100',
  )
  expect(await grid.innerHTML()).toBe(before)
})

test('a ranked row is a 44 pt target that opens the note', async ({ page }) => {
  await seed(page)
  const row = screen(page)
    .getByRole('region', { name: 'Most edited this week' })
    .getByRole('button')
    .filter({ hasText: '+240' })
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expect(row.locator('.phone-ranked-growth')).toHaveCSS(
    'font-variant-numeric',
    'tabular-nums',
  )
  await expect(row.locator('.phone-ranked-growth')).not.toHaveCSS('font-family', /mono/i)
  await row.click()
  await expect(page.getByRole('region', { name: 'Sync handshake' })).toBeVisible()
})
