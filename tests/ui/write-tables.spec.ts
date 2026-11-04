import type { Page } from '@playwright/test'
import { decodePng } from '../support/png'
import { changeEditorSettingsElsewhere, expect, test, openApp } from './fixtures'

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
const writeButton = (page: Page) =>
  page.locator('.editor-toolbar').getByRole('button', { name: 'Write Mode', exact: true })
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
  await expect(writeButton(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(modes(page).getByRole('button', { pressed: true })).toHaveCount(0)
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
const NOTE = `Above\n\n${TABLE}`
const ABOVE = ['Above', '']

test.use({ install: 'new' })

test.beforeEach(async ({ page }) => {
  await openApp(page)
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

test('fits every column to its widest cell on first draw, before the caret enters the table', async ({
  page,
}) => {
  await createNote(
    page,
    'Widths',
    `${TABLE}\n\n| Name | Quantity | Notes |\n| --- | --- | --- |\n| Tea | 2 | Hot |\n\nLast line`,
  )
  await expect(cells(page).first()).toBeVisible()
  // Every row is one line: a wrapped cell would be a line taller (the header's top hairline is a pixel).
  const heights = await page
    .locator('.cm-wm-cell')
    .evaluateAll((all) => all.map((cell) => cell.getBoundingClientRect().height))
  expect(heights).toHaveLength(10)
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1.5)
})

/** How many columns each grid row lays out: one for a row whose column rule is not in effect. */
const rowColumns = (page: Page) =>
  page
    .locator('.cm-line.cm-wm-row')
    .evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length),
    )

test('keeps every grid in its columns across notes, modes and a root that lost the column sheet', async ({
  page,
}) => {
  await createNote(page, 'Narrow', TABLE)
  await createNote(
    page,
    'Wide',
    '| Bold, italic, strikethrough | Press | Where |\n| --- | --- | --- |\n| New note | Cmd N | List |',
  )
  await expect.poll(() => rowColumns(page)).toEqual([3, 3])
  await noteRows(page).filter({ hasText: 'Narrow' }).click()
  await expect.poll(() => rowColumns(page)).toEqual([2, 2])
  // Another script replaces the root's adopted sheets without the column sheet.
  await page.locator('.editor').evaluate((host) => {
    const root = host.shadowRoot!
    root.adoptedStyleSheets = root.adoptedStyleSheets.filter(
      (sheet) =>
        !Array.from(sheet.cssRules).some((rule) =>
          (rule as CSSStyleRule).selectorText?.startsWith('.cm-wm-cols-'),
        ),
    )
  })
  await intoCell(page, 'Tea')
  await page.keyboard.type(' pot')
  await expect.poll(() => rowColumns(page)).toEqual([2, 2])
  await noteRows(page).filter({ hasText: 'Wide' }).click()
  await expect.poll(() => rowColumns(page)).toEqual([3, 3])
  await source(page)
  await expect.poll(() => rowColumns(page)).toEqual([3, 3])
  await noteRows(page).filter({ hasText: 'Narrow' }).click()
  await expect.poll(() => rowColumns(page)).toEqual([2, 2])
})

test('keeps the table bar off the block above the table', async ({ page }) => {
  await createNote(page, 'Over', `$$\nE = mc^2\n$$\n\n${TABLE}\n\nLast line`)
  const math = page.locator('.cm-wm-block-math')
  await expect(math.locator('math')).toHaveCount(1)
  await intoCell(page, 'Tea')
  await expect(bar(page)).toBeVisible()
  const above = (await math.boundingBox())!
  const box = (await page.locator('.cm-table-bar').boundingBox())!
  const head = (await page.locator('.cm-wm-row-head .cm-wm-cell').first().boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(above.y + above.height)
  expect(box.y + box.height).toBeLessThanOrEqual(head.y)
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

test('pins the table bar to the top of the visible editor once the header scrolls out', async ({
  page,
}) => {
  const rows = Array.from({ length: 60 }, (_, n) => `| row${n + 1} | ${n + 1} |`)
  await createNote(page, 'Long', `Above\n\n| Item | Qty |\n| --- | --: |\n${rows.join('\n')}`)
  await intoCell(page, 'row60')
  await expect(bar(page)).toBeVisible()
  const scroller = page.locator('[data-devot-part="editor-scroll"]')
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const view = (await scroller.boundingBox())!
  const caretCell = cells(page).filter({ hasText: /^row60$/ })
  await expect
    .poll(async () =>
      Math.abs(((await page.locator('.cm-table-bar').boundingBox())?.y ?? -1000) - view.y),
    )
    .toBeLessThanOrEqual(2)
  const head = (await page.locator('.cm-wm-row-head .cm-wm-cell').first().boundingBox())!
  expect(head.y + head.height).toBeLessThanOrEqual(view.y)
  const box = (await page.locator('.cm-table-bar').boundingBox())!
  const row = (await caretCell.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(row.y)
  expect(row.y + row.height).toBeLessThanOrEqual(view.y + view.height)
})

// A grid's row is a line as wide as the column; the caret's tint and the selection stay on the
// cells and leave the room beside the grid as it was.
test("tints the caret's cell and the cells a selection crosses, and nothing beside the grid", async ({
  page,
}) => {
  await changeEditorSettingsElsewhere(page, { highlightActiveLine: true })
  await createNote(page, 'Tints', `${NOTE}\n\nBelow`)
  await expect(cells(page)).toHaveCount(4)
  const content = (await body(page).boundingBox())!
  const rowOf = async (text: string) => {
    const box = (await cells(page)
      .filter({ hasText: new RegExp(`^${text}$`) })
      .boundingBox())!
    return Math.round(box.y + box.height / 2)
  }
  const aboveBox = (await page.locator('.cm-line', { hasText: /^Above$/ }).boundingBox())!
  const above = Math.round(aboveBox.y + aboveBox.height / 2)
  const head = await rowOf('Qty')
  const row = await rowOf('Tea')
  const tea = (await cells(page).filter({ hasText: /^Tea$/ }).boundingBox())!
  const grid = (await cells(page).filter({ hasText: /^Qty$/ }).boundingBox())!
  // Halfway from the grid's right edge to the column's.
  const right = Math.round((grid.x + grid.width + content.x + content.width) / 2)
  const shot = async () => decodePng(await page.screenshot({ scale: 'css' }))
  const at = (png: Awaited<ReturnType<typeof shot>>, x: number, y: number) => {
    const i = (y * png.width + x) * png.channels
    return [...png.pixels.slice(i, i + 3)]
  }
  const distance = (a: number[], b: number[]) => Math.max(...a.map((c, i) => Math.abs(c - b[i]!)))

  // The caret is on the last line, away from the table.
  const rest = await shot()

  await intoCell(page, 'Qty')
  await expect(page.locator('.cm-wm-cell-caret')).toHaveText('Qty')
  await expect(page.locator('.cm-line.cm-wm-row.cm-activeLine')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  )
  await expect(page.locator('.cm-wm-cell-caret')).not.toHaveCSS('background-image', 'none')
  const caret = await shot()
  expect(distance(at(caret, right, head), at(rest, right, head))).toBeLessThanOrEqual(2)

  await page.keyboard.press('ControlOrMeta+a')
  await expect(page.locator('.cm-wm-cell-selected')).toHaveCount(4)
  await expect(page.locator('.cm-wm-cell-caret')).toHaveCount(0)
  const all = await shot()
  const selection = at(all, right, above)
  expect(distance(selection, at(rest, right, above))).toBeGreaterThan(6)
  for (const y of [head, row])
    expect(
      distance(at(all, right, y), at(rest, right, y)),
      `beside the grid at ${y}`,
    ).toBeLessThanOrEqual(2)
  // A body row without a stripe shows the selection, not a hole in it.
  const inTea = at(all, Math.round(tea.x + tea.width - 4), row)
  expect(distance(inTea, selection)).toBeLessThanOrEqual(2)
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
