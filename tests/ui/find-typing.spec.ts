import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, openApp, test } from './fixtures'
import { median, watchKeys, type ViewLike } from './keystrokes'

// Typing in a 1 MB note with the find bar open on a query with thousands of matches: per keystroke, the
// editor's own work and the time from the key to the end of the frame that shows it, as medians. Find
// updates its matches only around each change, so the budgets are those of typing without the bar
// (long-note-typing.spec.ts); on CI they stretch (tests/support/budget.ts), and a local machine running
// several suites at once skips instead of failing.
const WORK_BUDGET_MS = 25
const FRAME_BUDGET_MS = 80
const NOTE_CHARS = 1_000_000
const KEYS = 'abcdefghijklmnopqrstuvwxyzabcd'
const QUERY = 'prose'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const bar = (page: Page) => page.getByRole('search', { name: 'Find in Note' })
const findStatus = (page: Page) => bar(page).getByRole('status')

function longNote(): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < NOTE_CHARS; i++) {
    const section = [
      `## Section ${i}`,
      '',
      'A paragraph of prose with **bold**, *emphasis*, `code` and a [link](https://example.com), long enough to wrap.',
      '',
      '- one item',
      '- two items',
      '',
    ].join('\n')
    sections.push(section)
    length += section.length
  }
  return sections.join('')
}

test('a keystroke in a 1 MB note with the find bar open stays within its budget', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Edit' }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await body(page).evaluate((el, text) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }, longNote())
  // The parser and the first save of the long note settle before the keys.
  await page.waitForTimeout(4000)

  await page.keyboard.press('Meta+f')
  await page.keyboard.type(QUERY)
  await expect(findStatus(page)).toContainText(' of ')
  await body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const text = view.state.doc.toString()
    const at = text.indexOf('A paragraph of prose', text.length / 2) + 2
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
    view.focus()
  })
  await page.waitForTimeout(500)
  await watchKeys(body(page))

  for (const key of KEYS) {
    await page.keyboard.press(key)
    await page.waitForTimeout(50)
  }
  await expect.poll(() => page.evaluate(() => window.devotKeys.length)).toBe(KEYS.length)
  await expect(body(page)).toContainText(`A ${KEYS}paragraph of prose`)
  await expect(bar(page)).toBeVisible()
  const total = await body(page).evaluate(
    (el, query) =>
      (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view.state.doc
        .toString()
        .split(query).length - 1,
    QUERY,
  )
  // The caret is on no match, so the bar shows the count alone.
  await expect(findStatus(page)).toHaveText(`${total.toLocaleString('en')} matches`)

  const keys = await page.evaluate(() => window.devotKeys)
  const work = median(keys.map((k) => k.work))
  const frame = median(keys.map((k) => k.frame))
  console.log(`find open, 1 MB: ${work.toFixed(1)} ms of work, ${frame.toFixed(1)} ms to the frame`)
  const scale = budgetScale(process.env)
  const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
  test.skip(
    overloaded && (work >= WORK_BUDGET_MS * scale || frame >= FRAME_BUDGET_MS * scale),
    `machine overloaded (${work.toFixed(1)} ms of work, ${frame.toFixed(1)} ms to the frame)`,
  )
  expect(work).toBeLessThan(WORK_BUDGET_MS * scale)
  expect(frame).toBeLessThan(FRAME_BUDGET_MS * scale)
})
