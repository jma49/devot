import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

// Each box read of a preview block forces layout; measuring every block of a big note after each
// keystroke held typing in Split view back (docs/specs/performance.md).
const NOTE_CHARS = 200_000
const READS_PER_KEY = 150

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

function longNote(): string {
  const sections: string[] = []
  for (let i = 0, length = 0; length < NOTE_CHARS; i++) {
    const section = [
      `## Section ${i}`,
      '',
      `A paragraph of prose with **bold**, *emphasis*, \`code\`, a footnote[^n${i}] and enough words to wrap at the width of the editor.`,
      '',
      '- one item',
      '- two items',
      '  - [ ] a nested task',
      '',
      '| Name | Price |',
      '| --- | ---: |',
      '| apple | 1 |',
      '',
      `[^n${i}]: Footnote ${i}.`,
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

declare global {
  interface Window {
    devotBlockReads: number
  }
}

test('typing in Split view in a 200 KB note measures only the preview blocks near the line', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await body(page).click()
  await page.keyboard.insertText('x')
  await body(page).evaluate((el, text) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  }, longNote())
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(preview(page).locator('section[data-footnotes] li')).not.toHaveCount(0, {
    timeout: 60_000,
  })
  await page.evaluate(() => {
    const w = window
    w.devotBlockReads = 0
    const read = w.Element.prototype.getBoundingClientRect
    w.Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.hasAttribute('data-source-line')) w.devotBlockReads += 1
      return read.call(this)
    }
  })
  await body(page).evaluate((el) => {
    const view = (el as unknown as { cmTile: { view: ViewLike } }).cmTile.view
    const text = view.state.doc.toString()
    const at = text.indexOf('A paragraph of prose', text.length / 2) + 2
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
    view.focus()
  })
  await expect.poll(() => preview(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.waitForTimeout(500)

  const keys = ['a', 'b', 'Enter', 'c', 'Enter', 'Enter', 'd', 'Backspace', 'Enter', 'e']
  await page.evaluate(() => (window.devotBlockReads = 0))
  for (const key of keys) {
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
  }
  await expect(preview(page)).toContainText('A paragraph of prose')
  await page.waitForTimeout(500)
  const reads = await page.evaluate(() => window.devotBlockReads)
  expect(reads / keys.length).toBeLessThan(READS_PER_KEY)
})
