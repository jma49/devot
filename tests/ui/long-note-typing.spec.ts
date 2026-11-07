import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, openApp, test } from './fixtures'
import { median, watchKeys, type ViewLike } from './keystrokes'

// Typing in a 200 KB note of prose, lists, tables and code blocks: per keystroke, the editor's own work
// (CodeMirror's update and its measure in the next frame) and the time from the key to the end of the
// frame that shows it, as medians. The budgets are for this WebKit on a developer's machine, well above
// what the editor takes there now (about 13 ms of work and 30 ms to the frame's end), and stretch on CI
// (tests/support/budget.ts); a local machine running several suites at once skips instead of failing.
const WORK_BUDGET_MS = 25
const FRAME_BUDGET_MS = 80
const NOTE_CHARS = 200_000
const KEYS = 'abcdefghijklmnopqrstuvwxyzabcd'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

function longNote(): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < NOTE_CHARS; i++) {
    const section = [
      `## Section ${i}`,
      '',
      'A paragraph of prose with **bold**, *emphasis*, `code`, a [link](https://example.com) and enough words to wrap at the width of the editor.',
      '',
      '- one item',
      '- two items',
      '  - [ ] a nested task',
      '1. ordered',
      '',
      '| Name | Price |',
      '| --- | ---: |',
      '| apple | 1 |',
      '',
      ...(i % 2 === 0
        ? [
            '```ts',
            'export const total = (items: number[]) => items.reduce((a, b) => a + b, 0)',
            '```',
          ]
        : ['```python', 'def total(items):', '    return sum(items)', '```']),
      '',
      '> A quote with [[Another note]].',
      '',
    ].join('\n')
    sections.push(section)
    length += section.length
  }
  return sections.join('')
}

test('a keystroke in a 200 KB note stays within its budget', async ({ page }) => {
  test.setTimeout(180_000)
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  const note = longNote()
  await body(page).evaluate((el, text) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }, note)
  // The parser and the first save of the long note settle before the keys.
  await page.waitForTimeout(3000)
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

  const keys = await page.evaluate(() => window.devotKeys)
  const work = median(keys.map((k) => k.work))
  const frame = median(keys.map((k) => k.frame))
  const scale = budgetScale(process.env)
  const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
  test.skip(
    overloaded && (work >= WORK_BUDGET_MS * scale || frame >= FRAME_BUDGET_MS * scale),
    `machine overloaded (${work.toFixed(1)} ms of work, ${frame.toFixed(1)} ms to the frame)`,
  )
  expect(work).toBeLessThan(WORK_BUDGET_MS * scale)
  expect(frame).toBeLessThan(FRAME_BUDGET_MS * scale)
})
