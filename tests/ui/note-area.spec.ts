import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openNoteMore,
  openNotePinned,
  pickMenuItem,
  test,
} from './fixtures'

// The note area: a toolbar with focus mode, Back and Forward at its start and
// the view modes and a More menu at its end (search sits in the note list);
// the title, then one compact line with the notebook, status and tags; the
// Markdown source highlighted; code blocks in the preview headed by their
// language's mark and title.

const toolbar = (page: Page) => page.locator('.editor-toolbar')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

/** The page's globals these tests read (this config has no DOM types). */
interface PageGlobals {
  document: {
    createRange(): {
      selectNodeContents(node: unknown): void
      getClientRects(): ArrayLike<{ x: number; y: number }>
    }
  }
  getComputedStyle(el: unknown): { color: string }
}

/** Where the first line of an element's text starts, on screen. */
const textStart = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const g = globalThis as unknown as PageGlobals
      const range = g.document.createRange()
      range.selectNodeContents(el)
      const rect = range.getClientRects()[0]
      return { x: rect?.x ?? -1, y: rect?.y ?? -1 }
    })

async function openNote(page: Page, text = '') {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill('Plan')
  if (text) {
    await body(page).click()
    await page.keyboard.insertText(text)
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the toolbar starts with focus mode, Back and Forward and ends with the view modes and More', async ({
  page,
}) => {
  await openNote(page)
  const names = await toolbar(page)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')))
  expect(names).toEqual(['Focus Mode', 'Back', 'Forward', 'Edit', 'Split', 'Preview', 'More'])
  await expect(toolbar(page)).toHaveCSS('border-bottom-width', '0px')

  // Search is in the note list's header, and its shortcut still finds it.
  await expect(toolbar(page).getByRole('searchbox')).toHaveCount(0)
  const search = page.getByRole('region', { name: 'Notes' }).getByRole('searchbox')
  await expect(search).toBeVisible()
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Shift+KeyF')
  await expect(search).toBeFocused()
})

test('the More menu holds the note actions that left the toolbar', async ({ page }) => {
  await openNote(page)
  const items = await openNoteMore(page)
  for (const label of ['Pin to Top', 'Revision History…', 'Move to Trash', 'Export as HTML…'])
    expect(items.some((line) => line === label || line.startsWith(`${label} `))).toBe(true)

  await pickMenuItem(page, 'Pin to Top')
  await expect.poll(() => openNotePinned(page)).toBe(true)
})

test('the notebook, status and tags share one compact line, worked by click and keyboard', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await page.getByRole('textbox', { name: 'Notebook name' }).fill('Inbox')
  await page.getByRole('textbox', { name: 'Notebook name' }).press('Enter')
  await openNote(page)
  const meta = page.locator('.note-meta')
  await expect(meta.locator('.meta-divider')).toHaveCount(0)

  // The notebook's name is bold; the select over it is what is focused and read.
  const book = page.getByRole('combobox', { name: 'Notebook' })
  await expect(meta.locator('.book-popup .popup-value')).toHaveText('Inbox')
  await expect(meta.locator('.book-popup .popup-value')).toHaveCSS('font-weight', '700')
  await book.focus()
  await expect(book).toBeFocused()
  await book.selectOption({ label: 'No Notebook' })
  await expect(meta.locator('.book-popup .popup-value')).toHaveText('No Notebook')

  // No status reads Status; picking one shows its name.
  const status = page.getByRole('combobox', { name: 'Status' })
  await expect(meta.locator('.status-none .popup-value')).toHaveText('Status')
  await status.focus()
  await status.selectOption({ label: 'Active' })
  await expect(meta.locator('.status-active .popup-value')).toHaveText('Active')

  // Tags are outlined pills after which Add Tags waits.
  const add = page.getByRole('combobox', { name: 'Add Tag' })
  await expect(add).toHaveAttribute('placeholder', 'Add Tags')
  await add.fill('work')
  await add.press('Enter')
  const chip = meta.locator('.chip', { hasText: 'work' })
  await expect(chip).toHaveCSS('border-top-style', 'solid')
  await expect(chip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await add.press('Backspace')
  await expect(chip).toHaveCount(0)

  // The title sits right under the toolbar.
  await expect(page.locator('.title')).toHaveCSS('font-size', '24px')
  const toolbarBox = await toolbar(page).boundingBox()
  const titleBox = await page.locator('.title').boundingBox()
  if (!toolbarBox || !titleBox) throw new Error('no title')
  expect(Math.abs(titleBox.y - (toolbarBox.y + toolbarBox.height))).toBeLessThan(2)

  // Everything sits on the title's left edge.
  const left = async (selector: string) => (await page.locator(selector).boundingBox())?.x ?? -1
  const titleX = await left('.title')
  expect(Math.abs((await left('.note-meta')) - titleX)).toBeLessThan(2)
  // Without line numbers (with them, the text starts after their gutter).
  await changeEditorSettingsElsewhere(page, { lineNumbers: false })
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0)
  await body(page).click()
  await page.keyboard.insertText('Body')
  const lineText = await textStart(page, '.cm-line')
  expect(Math.abs(lineText.x - titleX)).toBeLessThan(2)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the Markdown source is highlighted (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openNote(
      page,
      '### Free Mode\n\nPress <kbd>Cmd</kbd> to _go_ with `x` and [a](https://example.com)\n\n- item\n',
    )
    const colourOf = (text: string) =>
      page
        .locator('.cm-content span')
        .filter({ hasText: new RegExp(`^${text.replace(/[*()[\]]/g, '\\$&')}$`) })
        .first()
        .evaluate((el) => (globalThis as unknown as PageGlobals).getComputedStyle(el).color)
    const text = await body(page).evaluate(
      (el) => (globalThis as unknown as PageGlobals).getComputedStyle(el).color,
    )
    const mark = await colourOf('###')
    const heading = await colourOf(' Free Mode')
    expect(mark).not.toBe(heading)
    for (const colour of [mark, heading, await colourOf('kbd'), await colourOf('x')])
      expect(colour).not.toBe(text)
    await expect(
      page.locator('.cm-content span', { hasText: /^https:\/\/example\.com$/ }),
    ).toHaveCSS('text-decoration-line', 'underline')
  })
}

test('split mode gives the editor and the preview half each, with no rule and no reading width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  await openNote(page, 'text')
  await changeEditorSettingsElsewhere(page, { lineWrapping: true, readableWidth: true })
  const content = page.locator('.cm-content')
  // Outside split, the readable width holds.
  await expect(content).toHaveCSS('max-width', '720px')
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  await expect(preview(page)).toHaveCSS('border-left-width', '0px')
  await expect(content).toHaveCSS('max-width', 'none')
  const editorBox = await page.locator('.editor').boundingBox()
  const previewBox = await preview(page).boundingBox()
  if (!editorBox || !previewBox) throw new Error('no panes')
  expect(Math.abs(editorBox.width - previewBox.width)).toBeLessThan(2)
  // The gutter between the editor's text and the preview's is small.
  const gutter = await page.evaluate(() => {
    const d = (globalThis as unknown as { document: { querySelector(s: string): unknown } })
      .document
    const style = (el: unknown) =>
      (
        globalThis as unknown as { getComputedStyle(el: unknown): Record<string, string> }
      ).getComputedStyle(el)
    return (
      parseFloat(style(d.querySelector('.editor'))['paddingRight'] ?? '0') +
      parseFloat(style(d.querySelector('.preview'))['paddingLeft'] ?? '0')
    )
  })
  expect(gutter).toBeLessThanOrEqual(24)
})

test('a code block in the preview is headed by its language mark and title', async ({ page }) => {
  await openNote(
    page,
    [
      '```ts title="app.ts"',
      'const a = 1',
      '```',
      '',
      '```python',
      'print(1)',
      '```',
      '',
      '```nolang',
      'x',
      '```',
      '',
      '```',
      'plain',
      '```',
    ].join('\n'),
  )
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  const heads = preview(page).locator('.code-header')
  await expect(heads).toHaveCount(3)
  await expect(heads.nth(0).locator('.code-title')).toHaveText('app.ts')
  await expect(heads.nth(0).locator('svg.code-lang-icon')).toHaveCount(1)
  await expect(heads.nth(1).locator('.code-lang')).toHaveText('Python')
  // A language without a mark shows the generic mark and its name.
  await expect(heads.nth(2).locator('.code-lang')).toHaveText('nolang')
  await expect(heads.nth(2).locator('.code-lang-icon-generic')).toHaveCount(1)
  // The code starts below the header.
  const head = await heads.nth(0).boundingBox()
  const code = (await textStart(page, '.preview pre > code')).y
  expect(code).toBeGreaterThanOrEqual((head?.y ?? 0) + (head?.height ?? 0) - 1)

  // A changed info string updates the header.
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.insertText('```rust:main.rs')
  await expect(heads.nth(0).locator('.code-title')).toHaveText('main.rs')
})
