import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, openApp, test } from './fixtures'
import type { ViewLike } from './keystrokes'
import { longNote } from './longNote'

// The longest frame in the 2 s after each click: each switch froze WebKit for about 18 s while the scroll sync
// removed a wheel listener of its own from the preview when Split ended (#782), and still held 0.7 s once the
// preview's blocks sat on layers (#784); scrollSync.test.ts holds the listener itself. The budget stretches on
// CI (tests/support/budget.ts). A local machine running several suites at once skips instead of failing, but
// never past NOISE_CEILING_MS: the slowest switch seen under load 45 took under 6 s.
const SWITCH_BUDGET_MS = 2000
const NOISE_CEILING_MS = 4 * SWITCH_BUDGET_MS
const NOTE_CHARS = 600_000
const WATCH_MS = 2000

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const modeButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })

async function longestFrame(page: Page, mode: string): Promise<number> {
  await page.evaluate((ms) => {
    const run = { times: [] as number[], done: false }
    window.devotFrameTimes = run
    const start = performance.now()
    const frame = () => {
      const now = performance.now()
      run.times.push(now)
      if (now - start < ms) requestAnimationFrame(frame)
      else run.done = true
    }
    requestAnimationFrame(frame)
  }, WATCH_MS)
  await modeButton(page, mode).click()
  await page.waitForFunction(() => window.devotFrameTimes.done, null, { timeout: 120_000 })
  return page.evaluate(() => {
    const { times } = window.devotFrameTimes
    let longest = 0
    for (let i = 1; i < times.length; i++) longest = Math.max(longest, times[i]! - times[i - 1]!)
    return longest
  })
}

test('switching Split to Preview to Edit in a 600 KB note never holds a frame long', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const text = longNote(NOTE_CHARS)
  const last = text
    .match(/^## Section \d+$/gm)!
    .at(-1)!
    .slice(3)
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await body(page).evaluate((el, insert) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert } })
  }, text)
  // The preview is built in Split view, under the scroll sync's listeners.
  await modeButton(page, 'Split').click()
  await expect(preview(page).getByRole('heading', { name: last, exact: true })).toBeAttached({
    timeout: 60_000,
  })
  await page.waitForTimeout(1500)

  const toPreview = await longestFrame(page, 'Preview')
  await expect(body(page)).toBeHidden()
  await page.waitForTimeout(1000)
  const toEdit = await longestFrame(page, 'Edit')
  await expect(preview(page)).toHaveCount(0)

  const limit = SWITCH_BUDGET_MS * budgetScale(process.env)
  const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
  const longest = Math.max(toPreview, toEdit)
  test.skip(
    overloaded && longest >= limit && longest < NOISE_CEILING_MS,
    `machine overloaded (${toPreview.toFixed(0)} ms and ${toEdit.toFixed(0)} ms frames)`,
  )
  expect(toPreview).toBeLessThan(limit)
  expect(toEdit).toBeLessThan(limit)
})
