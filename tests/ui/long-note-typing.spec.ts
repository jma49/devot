import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, openApp, test } from './fixtures'
import { median, watchKeys, type ViewLike } from './keystrokes'

// Typing in a 200 KB note of prose, lists, tables and code blocks: per keystroke, the editor's own work
// (the transaction, CodeMirror's update and its measure in the next frame) and the time from the key to the end of the
// frame that shows it, as medians. The budgets are for this WebKit on a developer's machine, well above
// what the editor takes there now (about 13 ms of work and 30 ms to the frame's end), and stretch on CI
// (tests/support/budget.ts); a local machine running several suites at once skips instead of failing.
const WORK_BUDGET_MS = 25
const FRAME_BUDGET_MS = 80
const NOTE_CHARS = 200_000
const KEYS = 'abcdefghijklmnopqrstuvwxyzabcd'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

function longNote(chars: number): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < chars; i++) {
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

/** A new note holding `longNote(chars)`, once the parser and its first save have settled. */
async function openLongNote(page: Page, chars: number) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await body(page).evaluate((el, text) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }, longNote(chars))
  await page.waitForTimeout(3000)
}

test('a keystroke in a 200 KB note stays within its budget', async ({ page }) => {
  test.setTimeout(180_000)
  await openLongNote(page, NOTE_CHARS)
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

// Typing at the end of a note must cost what typing at its top does: no work may grow with the text before
// the caret (a parse, a scan or decorations from the note's start, heights measured above the viewport).
// The note is three times the one above, so such work shows against the rest. Each place is typed twice, in
// turns, a letter then Backspace so the note keeps its length, with pauses as a person leaves them; trimmed
// means keep a garbage collection or a late frame from deciding, and CI's one retry a noisy runner.
// Typing at a place waits until the parser has drawn it and gone quiet, as the top was before the first key:
// CodeMirror parses only 100 KB past the view, so the first keys after a jump to the end would otherwise time
// its catching up (seconds on CI, in either mode), not a keystroke.
// The bound catches work of about half a keystroke; a smaller cost, such as the highlighting walk that
// highlighting.test.ts holds, does not always cross it.
const PLACE_NOTE_CHARS = 600_000
const PLACE_RATIO = 1.5
const PLACE_KEYS = 20
const QUIET_MS = 1000

const trimmedMean = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const cut = Math.floor(sorted.length / 10)
  const kept = sorted.slice(cut, sorted.length - cut)
  return kept.reduce((sum, value) => sum + value, 0) / kept.length
}

/** Notes the time of each editor update from now on, for `quiet`. */
function watchUpdates(page: Page) {
  return body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const w = window
    w.devotLastUpdate = w.performance.now()
    const run = view.update.bind(view)
    view.update = (transactions: unknown) => {
      w.devotLastUpdate = w.performance.now()
      run(transactions)
    }
  })
}

/** Waits until the editor has gone `QUIET_MS` without an update: each slice of the parser's background work ends in one. */
async function quiet(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.performance.now() - window.devotLastUpdate), {
      timeout: 60_000,
    })
    .toBeGreaterThan(QUIET_MS)
}

async function typeAt(page: Page, place: 'top' | 'end') {
  await page.keyboard.press(place === 'top' ? 'ControlOrMeta+Home' : 'ControlOrMeta+End')
  const caret = await body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    return { head: view.state.selection.main.head, length: view.state.doc.length }
  })
  expect(caret.head).toBe(place === 'top' ? 0 : caret.length)
  const quote = body(page).locator('.cm-line', { hasText: 'A quote with' })
  await expect(place === 'top' ? quote.first() : quote.last()).toHaveClass(/cm-md-quote/, {
    timeout: 60_000,
  })
  await quiet(page)
  await page.evaluate(() => {
    window.devotKeys = []
  })
  for (let i = 0; i < PLACE_KEYS; i++) {
    await page.keyboard.press(i % 2 === 0 ? 'w' : 'Backspace')
    await page.waitForTimeout(120 + (i % 3) * 40)
  }
  await expect.poll(() => page.evaluate(() => window.devotKeys.length)).toBe(PLACE_KEYS)
  return page.evaluate(() => window.devotKeys)
}

for (const mode of [
  { name: 'Edit', command: 'view.edit' },
  { name: 'Write', command: 'view.write' },
]) {
  test(`in ${mode.name} mode, a keystroke at the end of a 600 KB note costs what one at its top does`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    await openLongNote(page, PLACE_NOTE_CHARS)
    await page.evaluate(
      (detail) => window.dispatchEvent(new CustomEvent('devot:open-url', { detail })),
      { kind: 'command', id: mode.command },
    )
    await watchUpdates(page)
    await quiet(page)
    await body(page).focus()
    await watchKeys(body(page))
    const typed = { top: [] as Window['devotKeys'], end: [] as Window['devotKeys'] }
    for (const place of ['top', 'end', 'top', 'end'] as const) {
      typed[place].push(...(await typeAt(page, place)))
    }
    const cost = (place: 'top' | 'end') => ({
      work: trimmedMean(typed[place].map((k) => k.work)),
      frame: trimmedMean(typed[place].map((k) => k.frame)),
    })
    const top = cost('top')
    const end = cost('end')
    const shown = `work and frame: end ${end.work.toFixed(1)} / ${end.frame.toFixed(1)} ms, top ${top.work.toFixed(1)} / ${top.frame.toFixed(1)} ms`
    const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
    test.skip(
      overloaded && (end.work >= top.work * PLACE_RATIO || end.frame >= top.frame * PLACE_RATIO),
      `machine overloaded (${shown})`,
    )
    expect(end.work, shown).toBeLessThan(top.work * PLACE_RATIO)
    expect(end.frame, shown).toBeLessThan(top.frame * PLACE_RATIO)
  })
}
