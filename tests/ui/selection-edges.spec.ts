import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

const NOTE = [
  '# Heading one',
  '',
  'Paragraph with **bold** and `code`.',
  '',
  '- bullet item',
  '1. ordered item',
  '- [ ] open task',
  '- [x] done task',
  '',
  '> quoted line',
  '',
  '> [!NOTE]',
  '> alert line',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '```py',
  'class Solution:',
  '    pass',
  '```',
  '',
  '---',
  '',
  'end',
].join('\n')

type Box = { x: number; y: number; width: number; height: number }

function selectionRects(page: Page): Promise<Box[]> {
  return page.locator('.cm-selectionBackground').evaluateAll((rects) =>
    rects.map((rect) => {
      const el = rect as unknown as { getBoundingClientRect(): Box }
      const { x, y, width, height } = el.getBoundingClientRect()
      return { x, y, width, height }
    }),
  )
}

/** The selection's outer edges, and how far its rows disagree. */
async function block(page: Page) {
  const drawn = (await selectionRects(page)).filter((r) => r.height > 0)
  const lefts = drawn.map((r) => r.x)
  const rights = drawn.map((r) => r.x + r.width)
  return {
    count: drawn.length,
    left: Math.min(...lefts),
    right: Math.max(...rights),
    leftSpread: Math.max(...lefts) - Math.min(...lefts),
    rightSpread: Math.max(...rights) - Math.min(...rights),
  }
}

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Edges')
  await body(page).click()
  await page.keyboard.insertText(text)
}

test('a selection of whole rows is one block across formats, and a partial row stays partial', async ({
  page,
}) => {
  await page.goto('/')
  await newNote(page, NOTE)

  const columns = await page.locator('.cm-content').evaluate((content) => {
    const view = globalThis as unknown as {
      getComputedStyle(el: unknown, pseudo?: string): { left: string }
      document: {
        createRange(): {
          selectNodeContents(node: unknown): void
          getClientRects(): ArrayLike<{ x: number }>
        }
      }
    }
    const textLeft = (el: unknown) => {
      const range = view.document.createRange()
      range.selectNodeContents(el)
      return range.getClientRects()[0]?.x ?? -1
    }
    const root = content as unknown as {
      querySelector(s: string): {
        getBoundingClientRect(): { left: number; right: number }
        querySelector(s: string): unknown
      }
    }
    const quote = root.querySelector('.cm-md-quote')
    const code = root.querySelector('.cm-codeblock')
    const fence = code.querySelector('.cm-codeblock-fence') ?? code
    const lines = (
      content as unknown as { querySelectorAll(s: string): ArrayLike<unknown> }
    ).querySelectorAll('.cm-line')
    let prose: unknown = null
    for (const line of Array.from(
      lines as ArrayLike<{ className: string; textContent: string | null }>,
    )) {
      if (line.className === 'cm-line' && (line.textContent ?? '').startsWith('Paragraph'))
        prose = line
    }
    const codeBox = code.getBoundingClientRect()
    const hang = Number.parseFloat(view.getComputedStyle(code, '::before').left)
    return {
      quote: quote.getBoundingClientRect().left,
      code: codeBox.left + hang,
      codeRight: codeBox.right - hang,
      codeText: textLeft(fence),
      quoteText: textLeft(quote),
      proseText: textLeft(prose),
    }
  })
  // The box and the quote's bar share the prose's column; the code sits inside the box.
  expect(Math.abs(columns.code - columns.proseText)).toBeLessThan(1)
  expect(Math.abs(columns.quote - columns.code)).toBeLessThan(1)
  expect(columns.codeText).toBeGreaterThan(columns.proseText + 8)
  expect(columns.quoteText).toBeGreaterThan(columns.proseText + 2)

  await page.keyboard.press('ControlOrMeta+a')
  const held: { edges: Awaited<ReturnType<typeof block>> | null } = { edges: null }
  await expect
    .poll(async () => {
      const edges = await block(page)
      if (edges.count > 1 && edges.leftSpread < 1 && edges.rightSpread < 1) {
        held.edges = edges
        return true
      }
      return false
    })
    .toBe(true)
  const blockEdges = held.edges
  if (!blockEdges) throw new Error('missing selection')
  // The tint wraps the code box, and meets the quote bar on the same edge.
  expect(blockEdges.left).toBeLessThanOrEqual(columns.code + 1)
  expect(blockEdges.right).toBeGreaterThanOrEqual(columns.codeRight - 1)
  expect(Math.abs(blockEdges.left - columns.quote)).toBeLessThan(1)

  // A short line, selected from its start to its end, fills the same block.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+End')
  await expect
    .poll(async () => {
      const edges = await block(page)
      return (
        edges.count >= 1 &&
        Math.abs(edges.left - blockEdges.left) < 1 &&
        Math.abs(edges.right - blockEdges.right) < 1
      )
    })
    .toBe(true)

  // Starting mid-line leaves the first row short of the block; ending at a row's end fills the right.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+End')
  await expect
    .poll(async () => {
      const edges = await block(page)
      return edges.leftSpread > 6 && edges.rightSpread < 1
    })
    .toBe(true)

  // Ending mid-line leaves the last row short; starting at a row's start fills the left.
  // Home, then two lines down, lands in the paragraph; four characters in is not its end.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect
    .poll(async () => {
      const edges = await block(page)
      return edges.rightSpread > 6 && edges.leftSpread < 1
    })
    .toBe(true)
})

test('a wrapped selection is the same block, quote and prose', async ({ page }) => {
  await page.goto('/')
  await changeEditorSettingsElsewhere(page, { lineWrapping: 'all', readableWidth: false })
  const long =
    'a quoted line that goes on and on with enough words to wrap over more than one row in this note, then some more words to be sure'
  await newNote(
    page,
    `# Heading\n\n> ${long}\n\nordinary paragraph with quite a lot of words that will also wrap over a second row when the note is this wide\n\nend`,
  )
  await page.keyboard.press('ControlOrMeta+a')
  await expect
    .poll(async () => {
      const edges = await block(page)
      return edges.count > 1 && edges.leftSpread < 1 && edges.rightSpread < 1
    })
    .toBe(true)
})
