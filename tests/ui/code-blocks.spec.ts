import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  clipboardWrites,
  expect,
  test,
  type TestWindow,
} from './fixtures'

// The preview's code blocks show a header and highlighting; task boxes tick the task in the note;
// front matter shows as properties.

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })

async function openNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Blocks')
  await body(page).click()
  await page.keyboard.insertText(text)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a code block shows its language, title and mark, highlighted, with the copy button in its header', async ({
  page,
}) => {
  await openNote(page, '```ts title="app.ts"\nconst a: number = 1\n```')
  const block = preview(page).locator('.code-block')
  const header = block.locator('.code-header')
  await expect(header.locator('.code-title')).toHaveText('app.ts')
  await expect(header.locator('.code-lang')).toHaveText('TypeScript')
  // The mark is real SVG, drawn at its size.
  const mark = header.locator('svg.code-lang-icon')
  expect(await mark.evaluate((el) => el.namespaceURI)).toBe('http://www.w3.org/2000/svg')
  expect((await mark.boundingBox())?.width).toBeGreaterThan(8)
  await expect(block.locator('code .hljs-keyword').first()).toHaveText('const')

  const copy = header.getByRole('button', { name: 'Copy Code' })
  await block.hover()
  await expect(copy).toHaveCSS('opacity', '1')
  await copy.click()
  await expect.poll(() => clipboardWrites(page)).toEqual(['const a: number = 1'])
})

test('line= numbers the lines beside the code, and copying leaves the numbers out', async ({
  page,
}) => {
  await openNote(page, '```ts line=10\nlet a = 1\nlet b = 2\n```')
  const block = preview(page).locator('.code-block')
  await expect(block.locator('.code-gutter')).toHaveText('10\n11')
  await expect(block.locator('.code-gutter')).toHaveAttribute('aria-hidden', 'true')
  await expect(block.locator('code .code-gutter')).toHaveCount(0)
  await block.hover()
  await block.getByRole('button', { name: 'Copy Code' }).click()
  await expect.poll(() => clipboardWrites(page)).toEqual(['let a = 1\nlet b = 2'])
})

test('a source header names the lines and ref, and its link opens in the system browser', async ({
  page,
}) => {
  const url = 'https://github.com/o/r/blob/a1b2c3d/src/a.ts#L10-L11'
  await openNote(
    page,
    `\`\`\`ts line=10-11 commit=a1b2c3d url=${url}\nlet a = 1\nlet b = 2\n\`\`\``,
  )
  const header = preview(page).locator('.code-header')
  await expect(header.locator('.code-lines-label')).toHaveText('Lines 10 to 11')
  await expect(header.locator('.code-ref')).toHaveText('in a1b2c3d')
  await header.getByRole('link', { name: /Open source/ }).click()
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls))
    .toContainEqual({
      cmd: 'open_external',
      args: { url: 'https://github.com/o/r/blob/a1b2c3d/src/a.ts' },
    })
})

test('a language the old highlighter lacked is highlighted', async ({ page }) => {
  await openNote(page, '```nix\nlet x = 1; in x\n```')
  await expect(preview(page).locator('code .hljs-keyword').first()).toBeVisible()
})

test('ticking a task in the preview ticks it in the note', async ({ page }) => {
  await openNote(page, '- [ ] first\n- [x] second')
  const boxes = preview(page).getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await boxes.first().click()
  await expect(body(page)).toContainText('- [x] first')
  await expect(boxes.first()).toBeChecked()
  await boxes.nth(1).click()
  await expect(body(page)).toContainText('- [ ] second')
  await expect(boxes.nth(1)).not.toBeChecked()
})

test('front matter shows as properties', async ({ page }) => {
  await openNote(page, '---\nauthor: me\ntags: [work, q4]\n---\n\nBody')
  const props = preview(page).locator('dl.frontmatter')
  await expect(props.locator('dt')).toHaveText(['author', 'tags'])
  await expect(props.locator('.frontmatter-chip')).toHaveText(['work', 'q4'])
})

// A whole-line selection reaches the code box's outer edges, the same on both sides, so the tint
// wraps the box. The active line's tint goes on the box, which stops at its rounded edges, and a
// selection takes the fill instead.
test('a selection is centred in a code block, and the active line keeps to its box', async ({
  page,
}) => {
  await changeEditorSettingsElsewhere(page, { highlightActiveLine: true })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Blocks')
  await body(page).click()
  await page.keyboard.insertText('intro\n```py\n#\nclass Solution:\n    ')
  await page.keyboard.press('ControlOrMeta+a')

  const first = page.locator('.cm-codeblock-first')
  const line = (await first.boundingBox())!
  // The box sits in from the line by the shared padding, on the text column.
  const hang = await first.evaluate((el) => {
    const view = globalThis as unknown as {
      getComputedStyle(e: unknown, pseudo?: string): Record<string, string>
    }
    return parseFloat(view.getComputedStyle(el, '::before').left ?? '0')
  })
  const boxLeft = line.x + hang
  const boxRight = line.x + line.width - hang

  const gaps = () =>
    page.locator('.cm-selectionBackground').evaluateAll((els) =>
      els.map((el) => {
        const r = (
          el as unknown as {
            getBoundingClientRect(): { left: number; width: number; height: number }
          }
        ).getBoundingClientRect()
        return { left: r.left, width: r.width, height: r.height }
      }),
    )
  // The tallest rectangle covers the whole lines between the selection's ends.
  await expect
    .poll(async () => {
      const rects = await gaps()
      const full = rects.reduce((a, b) => (b.height > a.height ? b : a))
      const leftGap = full.left - boxLeft
      const rightGap = boxRight - (full.left + full.width)
      return Math.abs(leftGap) < 1 && Math.abs(rightGap) < 1
    })
    .toBe(true)

  const tint = () =>
    page.locator('.cm-activeLine').evaluate((el) => {
      const view = globalThis as unknown as {
        getComputedStyle(e: unknown, pseudo?: string): Record<string, string>
      }
      const box = view.getComputedStyle(el, '::before')
      return {
        line: view.getComputedStyle(el).backgroundColor,
        box: box.backgroundColor,
        image: box.backgroundImage,
        bottom: box.bottom,
      }
    })

  // The selection is its own tint; the active line's would be drawn over it.
  expect(await tint()).toMatchObject({ line: 'rgba(0, 0, 0, 0)', image: 'none' })
  expect((await tint()).box).not.toBe('rgba(0, 0, 0, 0)')

  // A caret keeps the tint, drawn by the box, which reaches past the last line instead of padding it.
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await tint()).image).toContain('linear-gradient')
  const caret = await tint()
  expect(caret.line).toBe('rgba(0, 0, 0, 0)')
  expect(parseFloat(caret.bottom ?? '0')).toBeLessThan(0)
})

test('line numbers stay evenly spaced through a code block in the editor', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { lineNumbers: true })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Rhythm')
  await body(page).click()
  await page.keyboard.insertText('one\ntwo\n```py\nx = 1\ny = 2\n```\nthree\nfour')
  await expect(page.locator('.cm-line')).toHaveCount(8)
  const tops = (selector: string) =>
    page.locator(selector).evaluateAll(
      (els, numbered) =>
        els.flatMap((el) => {
          const e = el as unknown as {
            style: { visibility: string }
            textContent: string
            getBoundingClientRect(): { top: number }
          }
          if (e.style.visibility === 'hidden') return []
          if (numbered && !/^\d+$/.test(e.textContent.trim())) return []
          return [e.getBoundingClientRect().top]
        }),
      selector.includes('gutter'),
    )
  const numbers = await tops('.cm-lineNumbers .cm-gutterElement')
  const gaps = numbers.slice(1).map((top, i) => top - numbers[i]!)
  // Sub-pixel line heights round either way; the old padding added 5 to 11 px around the block.
  expect(Math.max(...gaps) - Math.min(...gaps), `gaps ${gaps.join(', ')}`).toBeLessThan(1)
  const lines = await tops('.cm-line')
  numbers.forEach((top, i) => expect(Math.abs(top - lines[i]!)).toBeLessThan(1))
})
