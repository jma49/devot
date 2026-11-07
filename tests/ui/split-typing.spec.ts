import type { Page } from '@playwright/test'
import { cpus, loadavg } from 'node:os'
import { budgetScale } from '../support/budget'
import { expect, openApp, test } from './fixtures'

// Typing in Split view in a 200 KB note with a footnote and a reference definition in every
// section: per keystroke, the time from the key to the end of the frame in which the preview
// shows it, as a median. Footnotes and definitions reach across the note, and a note that had
// them rendered whole on every keystroke (about 1 s here, on a loaded machine); now only the
// edited piece renders again (about 115 ms on the same machine). The budget is for this WebKit on
// a developer's machine and stretches on CI (tests/support/budget.ts); a local machine running
// several suites at once skips instead of failing.
const PREVIEW_BUDGET_MS = 150
const NOTE_CHARS = 200_000
const KEYS = 'abcdefghijklmnopqrstuvwxyzabcd'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

function longNote(): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < NOTE_CHARS; i++) {
    const section = [
      `## Section ${i}`,
      '',
      `A paragraph of prose with **bold**, *emphasis*, \`code\`, a [reference][ref ${i}], a footnote[^n${i}] and enough words to wrap at the width of the editor.`,
      '',
      '- one item',
      '- two items',
      '  - [ ] a nested task',
      '',
      '| Name | Price |',
      '| --- | ---: |',
      '| apple | 1 |',
      '',
      '```ts',
      'export const total = (items: number[]) => items.reduce((a, b) => a + b, 0)',
      '```',
      '',
      `[^n${i}]: Footnote ${i}, with a [link](https://example.com/${i}).`,
      '',
      `[ref ${i}]: https://example.com/ref/${i}`,
      '',
    ].join('\n')
    sections.push(section)
    length += section.length
  }
  return sections.join('')
}

interface ViewLike {
  state: { doc: { length: number; toString(): string } }
  dispatch(spec: unknown): void
  focus(): void
}

/** Times each keystroke from now on: the key to the end of the frame that shows it in the preview. */
function watchPreview(page: Page) {
  return preview(page).evaluate((article) => {
    const w = window
    w.devotPreviewKeys = []
    const pending: number[] = []
    let typed = 0
    w.addEventListener('keydown', () => pending.push(w.performance.now()), true)
    const shown = (node: Node) => {
      const block = (node instanceof Element ? node : node.parentElement)?.closest('p')
      return /^A ([a-z]*)paragraph of prose/.exec(block?.textContent ?? '')?.[1]?.length ?? 0
    }
    new MutationObserver((records) => {
      const now = Math.max(typed, ...records.map((record) => shown(record.target)))
      if (now <= typed) return
      const keys = pending.splice(0, now - typed)
      typed = now
      w.requestAnimationFrame(() => {
        const after = new w.MessageChannel()
        after.port1.onmessage = () => {
          const end = w.performance.now()
          for (const start of keys) w.devotPreviewKeys.push(end - start)
        }
        after.port2.postMessage(null)
      })
    }).observe(article, { subtree: true, childList: true, characterData: true })
  })
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!

test('a keystroke in Split view in a 200 KB note with footnotes reaches the preview within its budget', async ({
  page,
}) => {
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
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(preview(page).locator('section[data-footnotes] li')).not.toHaveCount(0, {
    timeout: 60_000,
  })
  // The parser, the first save and the first render of the long note settle before the keys.
  await page.waitForTimeout(3000)
  await body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const text = view.state.doc.toString()
    const at = text.indexOf('A paragraph of prose', text.length / 2) + 2
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
    view.focus()
  })
  await page.waitForTimeout(500)
  await watchPreview(page)

  for (const key of KEYS) {
    await page.keyboard.press(key)
    await page.waitForTimeout(50)
  }
  await expect
    .poll(() => page.evaluate(() => window.devotPreviewKeys.length), { timeout: 60_000 })
    .toBe(KEYS.length)
  await expect(preview(page)).toContainText(`A ${KEYS}paragraph of prose`)

  const shown = median(await page.evaluate(() => window.devotPreviewKeys))
  const limit = PREVIEW_BUDGET_MS * budgetScale(process.env)
  const overloaded = !process.env['CI'] && loadavg()[0]! > cpus().length
  test.skip(
    overloaded && shown >= limit,
    `machine overloaded (${shown.toFixed(1)} ms to the preview's frame)`,
  )
  expect(shown).toBeLessThan(limit)
})
