import type { Page } from '@playwright/test'
import { clipboardWrites, expect, test, type TestWindow } from './fixtures'

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
