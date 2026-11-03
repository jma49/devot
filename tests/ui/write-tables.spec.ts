import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Write mode's tables (src/renderer/src/editor/write/tableGrid.ts): a table shows as a grid and the
// caret edits its cells in place; the note's Markdown, read through Edit mode, stays a formatted GFM
// table.

const KA = String.fromCodePoint(0x304b)
const KAN = String.fromCodePoint(0x6f22)

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const cells = (page: Page) => page.locator('.cm-wm-cell')
const modes = (page: Page) => page.getByRole('group', { name: 'View mode' })
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Table', exact: true })

const runCommand = (page: Page, id: string) =>
  page.evaluate(
    (detail) => {
      const w = globalThis as unknown as {
        dispatchEvent(e: unknown): void
        CustomEvent: new (t: string, init: { detail: unknown }) => unknown
      }
      w.dispatchEvent(new w.CustomEvent('devot:open-url', { detail }))
    },
    { kind: 'command', id },
  )

async function source(page: Page): Promise<string[]> {
  await runCommand(page, 'view.edit')
  await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Edit')
  const text = await lines(page)
  await runCommand(page, 'view.write')
  await expect(modes(page).getByRole('button', { pressed: true })).toHaveAccessibleName('Write')
  return text
}

async function createNote(page: Page, title: string, text: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await titleField(page).fill(title)
  await body(page).click()
  await page.keyboard.insertText(text)
}

/** Puts the caret at the end of the cell that shows `text`, by a click right of its text. */
async function intoCell(page: Page, text: string) {
  const cell = cells(page).filter({ hasText: new RegExp(`^${text}$`) })
  const box = await cell.boundingBox()
  if (!box) throw new Error('E_TEST_NO_CELL')
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2)
}

/**
 * Types `steps` as an input method does at `column` of the shown text of line `line` (0-based):
 * each step replaces the text composed so far in the DOM, between `compositionstart` and
 * `compositionend`, a frame apart, and the editor reads the DOM.
 */
function compose(page: Page, lineIndex: number, col: number, parts: string[]) {
  return body(page).evaluate(
    async (content, asked) => {
      const { line, column, steps } = asked
      type Node = { nodeType: number; data: string; childNodes: Node[] }
      type El = Node & {
        querySelectorAll(s: string): El[]
        dispatchEvent(e: unknown): boolean
      }
      const w = globalThis as unknown as {
        CompositionEvent: new (t: string, init: object) => unknown
        InputEvent: new (t: string, init: object) => unknown
        requestAnimationFrame(f: () => void): void
        document: { getSelection(): { collapse(n: Node, o: number): void } | null }
      }
      const el = content as unknown as El
      const frame = () => new Promise<void>((resolve) => w.requestAnimationFrame(() => resolve()))
      const place = () => {
        const row = el.querySelectorAll('.cm-line')[line]
        if (!row) throw new Error('E_TEST_NO_LINE')
        const texts: Node[] = []
        const walk = (n: Node) => {
          if (n.nodeType === 3) texts.push(n)
          else for (const c of n.childNodes) walk(c)
        }
        walk(row)
        let at = column
        for (const n of texts) {
          if (at <= n.data.length) return { node: n, offset: at }
          at -= n.data.length
        }
        throw new Error('E_TEST_NO_COLUMN')
      }
      const init = { bubbles: true, composed: true }
      el.dispatchEvent(new w.CompositionEvent('compositionstart', { ...init, data: '' }))
      let typed = ''
      for (const step of steps) {
        const { node, offset } = place()
        node.data = node.data.slice(0, offset) + step + node.data.slice(offset + typed.length)
        typed = step
        try {
          w.document.getSelection()?.collapse(node, offset + step.length)
        } catch {
          // The editor reads the change from the text alone.
        }
        el.dispatchEvent(new w.CompositionEvent('compositionupdate', { ...init, data: step }))
        el.dispatchEvent(
          new w.InputEvent('input', {
            ...init,
            data: step,
            inputType: 'insertCompositionText',
            isComposing: true,
          }),
        )
        await frame()
      }
      el.dispatchEvent(new w.CompositionEvent('compositionend', { ...init, data: typed }))
      await frame()
      await frame()
    },
    { line: lineIndex, column: col, steps: parts },
  )
}

const TABLE = '| Item | Qty |\n| --- | --: |\n| Tea | 2 |'
// Text above the table leaves room for the table bar, which would otherwise sit over its first row.
const NOTE = `Above\n\n${TABLE}`
const ABOVE = ['Above', '']

test.use({ install: 'new' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('draws a table as a grid and types in a cell', async ({ page }) => {
  await createNote(page, 'Grid', `Above\n\n${TABLE}`)
  await expect(cells(page)).toHaveCount(4)
  // The delimiter row is hidden in the header's line, and no pipe shows.
  await expect.poll(() => lines(page)).toEqual(['Above', '', 'ItemQty', 'Tea2'])
  await intoCell(page, 'Tea')
  await page.keyboard.type(' pot|x')
  await expect.poll(() => lines(page)).toEqual(['Above', '', 'ItemQty', 'Tea pot|x2'])
  expect(await source(page)).toEqual([
    'Above',
    '',
    '| Item       | Qty |',
    '| ---------- | --: |',
    '| Tea pot\\|x |   2 |',
  ])
  await page.keyboard.press('ControlOrMeta+KeyZ')
  expect(await source(page)).toEqual(['Above', '', TABLE.split('\n')].flat())
})

test('Tab, Shift+Tab and Return move through the grid', async ({ page }) => {
  await createNote(page, 'Tabs', NOTE)
  await intoCell(page, 'Tea')
  await page.keyboard.press('Tab')
  await page.keyboard.type('0')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('s')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Milk')
  await page.keyboard.press('Tab')
  await page.keyboard.type('1')
  await expect(cells(page)).toHaveCount(6)
  await expect.poll(() => lines(page)).toEqual([...ABOVE, 'ItemQty', 'Teas20', 'Milk1'])
  expect(await source(page)).toEqual([
    ...ABOVE,
    '| Item | Qty |',
    '| ---- | --: |',
    '| Teas |  20 |',
    '| Milk |   1 |',
  ])
})

test('moves a column from the table bar and keeps the caret in its cell', async ({ page }) => {
  await createNote(page, 'Columns', NOTE)
  await intoCell(page, 'Tea')
  await intoCell(page, 'Qty')
  await expect(bar(page)).toBeVisible()
  await bar(page).getByRole('button', { name: 'Move Column Left' }).click()
  await expect.poll(() => lines(page)).toEqual([...ABOVE, 'QtyItem', '2Tea'])
  await body(page).focus()
  await page.keyboard.type('s')
  await expect.poll(() => lines(page)).toEqual([...ABOVE, 'QtysItem', '2Tea'])
  expect(await source(page)).toEqual([
    ...ABOVE,
    '| Qtys | Item |',
    '| ---: | ---- |',
    '|    2 | Tea  |',
  ])
})

test('shows the table bar above the grid, at its left edge, without covering the header', async ({
  page,
}) => {
  await createNote(page, 'Bar', NOTE)
  await intoCell(page, 'Tea')
  await expect(bar(page)).toBeVisible()
  const head = await page.locator('.cm-wm-row-head .cm-wm-cell').first().boundingBox()
  const box = await page.locator('.cm-table-bar').boundingBox()
  expect(box!.y + box!.height).toBeLessThanOrEqual(head!.y)
  expect(Math.abs(box!.x - head!.x)).toBeLessThanOrEqual(1)
})

test('shows the source while several cursors are in the table', async ({ page }) => {
  await createNote(page, 'Cursors', NOTE)
  await intoCell(page, 'Tea')
  await page.keyboard.press('Control+Shift+ArrowUp')
  await expect(cells(page)).toHaveCount(0)
  await expect.poll(() => lines(page)).toEqual([...ABOVE, ...TABLE.split('\n')])
  await page.keyboard.press('Escape')
  await expect(cells(page)).toHaveCount(4)
})

test('composing in a cell keeps every character in order', async ({ page }) => {
  await createNote(page, 'Input', NOTE)
  await intoCell(page, 'Tea')
  await compose(page, 3, 3, ['k', KA, KAN])
  await expect.poll(() => lines(page)).toEqual([...ABOVE, 'ItemQty', `Tea${KAN}2`])
  await page.keyboard.type('x')
  await expect.poll(() => lines(page)).toEqual([...ABOVE, 'ItemQty', `Tea${KAN}x2`])
  expect(await source(page)).toEqual([
    ...ABOVE,
    '| Item   | Qty |',
    '| ------ | --: |',
    `| Tea${KAN}x |   2 |`,
  ])
})
