import type { Page } from '@playwright/test'
import { seedNotes } from './renders'
import {
  pickBook,
  pickStatus,
  changeEditorSettingsElsewhere,
  expect,
  openNoteMore,
  openNotePinned,
  pickMenuItem,
  test,
  bookPicker,
} from './fixtures'

const toolbar = (page: Page) => page.locator('.editor-toolbar')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

/** Page globals these tests read; no DOM types in this config. */
interface PageGlobals {
  document: {
    createRange(): {
      selectNodeContents(node: unknown): void
      getClientRects(): ArrayLike<{ x: number; y: number }>
    }
  }
  getComputedStyle(el: unknown): { color: string }
}

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

  await expect(toolbar(page).getByRole('searchbox')).toHaveCount(0)
  const search = page.getByRole('region', { name: 'Notes' }).getByRole('searchbox')
  await expect(search).toBeVisible()
  await body(page).click()
  await page.keyboard.press('Meta+Shift+KeyF')
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

  const book = bookPicker(page)
  await expect(meta.locator('.book-popup .popup-value')).toHaveText('Inbox')
  await expect(meta.locator('.book-popup .popup-value')).toHaveCSS('font-weight', '700')
  await book.focus()
  await expect(book).toBeFocused()
  await pickBook(page, 'No Notebook')
  await expect(meta.locator('.book-popup .popup-value')).toHaveText('No Notebook')
  await expect(book).toBeFocused()

  await expect(meta.locator('.status-none .popup-value')).toHaveText('Status')
  await pickStatus(page, 'Active')
  await expect(meta.locator('.status-active .popup-value')).toHaveText('Active')

  const add = page.getByRole('combobox', { name: 'Add Tag' })
  await expect(add).toHaveAttribute('placeholder', 'Add Tags')
  await add.fill('work')
  await add.press('Enter')
  const chip = meta.locator('.chip', { hasText: 'work' })
  await expect(chip).toHaveCSS('border-top-style', 'solid')
  await expect(chip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await add.press('Backspace')
  await expect(chip).toHaveAttribute('data-selected', 'true')
  await add.press('Backspace')
  await expect(chip).toHaveCount(0)

  await expect(page.locator('.title')).toHaveCSS('font-size', '24px')
  const toolbarBox = await toolbar(page).boundingBox()
  const titleBox = await page.locator('.title').boundingBox()
  if (!toolbarBox || !titleBox) throw new Error('no title')
  expect(Math.abs(titleBox.y - (toolbarBox.y + toolbarBox.height))).toBeLessThan(2)

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
    // Inline code keeps the text colour (its box sets it apart).
    for (const colour of [mark, heading, await colourOf('kbd')]) expect(colour).not.toBe(text)
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
  await changeEditorSettingsElsewhere(page, { lineWrapping: 'all', readableWidth: true })
  const content = page.locator('.cm-content')
  await expect(content).toHaveCSS('max-width', '740px')
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
  await expect(heads.nth(2).locator('.code-lang')).toHaveText('nolang')
  await expect(heads.nth(2).locator('.code-lang-icon-generic')).toHaveCount(1)
  const head = await heads.nth(0).boundingBox()
  const code = (await textStart(page, '.preview pre > code')).y
  expect(code).toBeGreaterThanOrEqual((head?.y ?? 0) + (head?.height ?? 0) - 1)

  await body(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.insertText('```rust:main.rs')
  await expect(heads.nth(0).locator('.code-title')).toHaveText('main.rs')
})

test('a new note made in Preview opens in Edit, ready for typing', async ({ page }) => {
  await openNote(page, 'first')
  const modes = page.getByRole('group', { name: 'View mode' })
  await modes.getByRole('button', { name: 'Preview' }).click()
  await expect(body(page)).toBeHidden()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(modes.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true')
  await expect(body(page)).toBeVisible()
})

test('the title field waits while another note opens, so typing never lands on the note left (#250)', async ({
  page,
}) => {
  await seedNotes(page, 3)
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  const row = (title: string) =>
    rows.filter({ has: page.locator('.row-title', { hasText: new RegExp(`^${title}$`) }) })
  await row('Note 1').click()
  await expect(titleField(page)).toHaveValue('Note 1')

  const readOnlyAtClick = await page.evaluate(async () => {
    const target = Array.from(document.querySelectorAll('[role=option] .row-title')).find(
      (el) => el.textContent === 'Note 2',
    )
    target?.closest('[role=option]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // React commits the click's state in a microtask; the open itself waits on the core.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    const field = document.querySelector<HTMLInputElement>('input.title')
    return field?.readOnly
  })
  expect(readOnlyAtClick).toBe(true)
  await titleField(page).fill('Food')
  await expect(titleField(page)).toHaveValue('Food')
  await expect(row('Food')).toHaveCount(1)
  await expect(row('Note 1')).toHaveCount(1)
  await expect(row('Note 2')).toHaveCount(0)
})

test('what is typed right after New Note, before the editor has loaded, lands in the body in order', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'New Note',
    )
    button?.click()
    ;(document.activeElement as HTMLElement | null)?.blur()
    for (const key of 'Alpha')
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      )
  })
  await expect(body(page)).toHaveText('Alpha')
  await page.keyboard.type(' next')
  await expect(body(page)).toHaveText('Alpha next')
})
