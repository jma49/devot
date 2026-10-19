import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Activity' })
const grid = (page: Page) => sheet(page).getByRole('grid', { name: 'Activity by day' })
const day = (page: Page, label: string | RegExp) =>
  grid(page).getByRole('gridcell', { name: label })

/** View > Activity… (the native menu reaches the page as this event). */
const showActivity = (page: Page) =>
  page.evaluate(() => {
    const w = globalThis as unknown as {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string) => unknown
    }
    w.dispatchEvent(new w.CustomEvent('devot:show-activity'))
  })

/**
 * Fixes `Date.now()` at Wednesday 2026-10-07 15:00 local and stores two notes with history around it. Playwright's
 * clock is not used: its script does not run with Object.prototype frozen, as the app has it.
 */
async function seed(page: Page) {
  await page.addInitScript(() => {
    const fixed = new Date(2026, 9, 7, 15).getTime()
    Date.now = () => fixed
  })
  await page.goto('/')
  await page.evaluate(() => {
    const local = (month: number, date: number, hour: number) =>
      new Date(2026, month - 1, date, hour).getTime()
    const note = (id: string, title: string, created: number, updated: number, body: string) => ({
      id,
      title,
      titleHlc: '0000000000001-0000-test',
      bodyMd: body,
      ydoc: [0, 0],
      bookId: null,
      bookHlc: '',
      status: 'none',
      statusHlc: '',
      pinned: false,
      pinnedHlc: '',
      createdAt: created,
      updatedAt: updated,
      deletedAt: null,
      deletedHlc: null,
    })
    const a = '0192a6f0-0000-7000-8000-00000000000a'
    const b = '0192a6f0-0000-7000-8000-00000000000b'
    localStorage.setItem(
      'devot.test.notes',
      JSON.stringify([
        note(a, 'Today', local(10, 7, 10), local(10, 7, 10), 'hello'),
        note(b, 'Draft', local(9, 1, 9), local(10, 6, 18), 'x'.repeat(40)),
      ]),
    )
    const revision = (id: string, kind: string, at: number, length: number | null, noteId = b) => ({
      id: `0192a6f0-0000-7000-9000-${id.padStart(12, '0')}`,
      noteId,
      kind,
      at,
      ydoc: kind === 'body' ? [0, 0] : null,
      length,
      value: kind === 'title' ? 'Draft' : null,
    })
    localStorage.setItem(
      'devot.test.revisions',
      JSON.stringify([
        revision('1', 'body', local(10, 5, 12), 100),
        revision('2', 'body', local(10, 6, 12), 40),
        revision('3', 'title', local(10, 6, 13), null),
        revision('4', 'body', local(10, 7, 10), 5, a),
      ]),
    )
  })
  await page.reload()
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(2)
}

test('shows 52 weeks of activity, each day with its totals', async ({ page }) => {
  await seed(page)
  await showActivity(page)
  await expect(sheet(page)).toBeVisible()
  // 51 full weeks, then Monday to Wednesday of this one.
  await expect(grid(page).getByRole('row')).toHaveCount(7)
  await expect(grid(page).getByRole('gridcell')).toHaveCount(51 * 7 + 3)
  await expect(
    day(page, 'Wednesday, October 7, 2026: 1 note created, 1 note edited, 5 characters changed'),
  ).toBeVisible()
  await expect(
    day(page, 'Tuesday, October 6, 2026: 1 note edited, 60 characters changed'),
  ).toBeVisible()
  await expect(
    day(page, 'Monday, October 5, 2026: 1 note edited, 100 characters changed'),
  ).toBeVisible()
  await expect(day(page, 'Tuesday, September 1, 2026: 1 note created')).toBeVisible()
  await expect(day(page, 'Sunday, October 4, 2026: No activity')).toBeVisible()
  await expect(grid(page).getByRole('gridcell').first()).toHaveAccessibleName(
    'Monday, October 13, 2025: No activity',
  )
  await expect(sheet(page)).toContainText('165 characters changed')
  await expect(sheet(page)).toContainText('2 notes created')
  await expect(sheet(page)).toContainText('4 active days')
  await expect(sheet(page).getByText('Less', { exact: true })).toBeVisible()
  await expect(sheet(page).getByText('More', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet(page)).toHaveCount(0)
})

test('hovering or moving through the days shows their totals', async ({ page }) => {
  await seed(page)
  await showActivity(page)
  const readout = sheet(page).locator('.activity-readout')
  const today = day(page, /^Wednesday, October 7, 2026:/)
  await expect(today).toBeFocused()
  await expect(readout).toHaveText(
    'Wednesday, October 7, 2026: 1 note created, 1 note edited, 5 characters changed',
  )
  await day(page, /^Monday, October 5, 2026:/).hover()
  await expect(readout).toHaveText('Monday, October 5, 2026: 1 note edited, 100 characters changed')
  await sheet(page).getByRole('heading', { name: 'Activity' }).hover()
  await expect(readout).toHaveText(/^Wednesday, October 7, 2026:/)

  await page.keyboard.press('ArrowLeft')
  await expect(day(page, /^Wednesday, September 30, 2026:/)).toBeFocused()
  await expect(readout).toHaveText('Wednesday, September 30, 2026: No activity')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowUp')
  await expect(day(page, /^Tuesday, October 6, 2026:/)).toBeFocused()
  await expect(readout).toHaveText('Tuesday, October 6, 2026: 1 note edited, 60 characters changed')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(today).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(today).toBeFocused()
  await page.keyboard.press('Home')
  await expect(day(page, /^Monday, October 13, 2025:/)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(day(page, /^Monday, October 13, 2025:/)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(day(page, /^Monday, October 13, 2025:/)).toBeFocused()
  await page.keyboard.press('End')
  await expect(today).toBeFocused()
  await expect(grid(page).locator('[tabindex="0"]')).toHaveCount(1)
})

test('shades days through theme colours, in light and dark', async ({ page }) => {
  await seed(page)
  await showActivity(page)
  const shade = (label: RegExp) =>
    day(page, label).evaluate(
      (el) =>
        (
          globalThis as unknown as {
            getComputedStyle(e: unknown): { backgroundColor: string }
          }
        ).getComputedStyle(el).backgroundColor,
    )
  const busiest = /^Monday, October 5, 2026:/
  const idle = /^Sunday, October 4, 2026:/
  const created = /^Tuesday, September 1, 2026:/
  await expect(day(page, busiest)).toHaveClass(/\bactivity-level-4\b/)
  await expect(day(page, idle)).toHaveClass(/\bactivity-level-0\b/)
  await expect(day(page, created)).toHaveClass(/\bactivity-level-1\b/)
  const light = [await shade(idle), await shade(created), await shade(busiest)]
  expect(new Set(light).size).toBe(3)
  await expect(sheet(page).locator('.activity-legend .activity-cell')).toHaveCount(5)

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => shade(busiest)).not.toBe(light[2])
  const dark = [await shade(idle), await shade(created), await shade(busiest)]
  expect(new Set(dark).size).toBe(3)
  expect(dark[1]).not.toBe(light[1])
})

test("counts what was just typed into today's square", async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('Hello there')
  await showActivity(page)
  const today = grid(page).locator('[role="gridcell"][tabindex="0"]')
  await expect(today).toHaveAttribute(
    'aria-label',
    /: 1 note created, 1 note edited, 11 characters changed$/,
  )
  await expect(today).toHaveClass(/\bactivity-level-4\b/)
})
