import type { Page } from '@playwright/test'
import { clipboardWrites, expect, test } from './fixtures'

// A copy button on each fenced code block in the preview. It copies the
// block's text as written, is reachable from the keyboard, says that it
// copied, and is the page's own control: never in the note's HTML or on paper.

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const copyButtons = (page: Page) => preview(page).getByRole('button', { name: 'Copy Code' })

interface PasteGlobals {
  devotPastedHtml?: string
  document: {
    createElement(tag: string): {
      contentEditable: string
      style: { setProperty(name: string, value: string): void }
      setAttribute(name: string, value: string): void
      addEventListener(
        type: 'paste',
        listener: (event: { clipboardData: { getData(type: string): string } | null }) => void,
      ): void
    }
    createRange(): {
      setStart(node: unknown, offset: number): void
      setEnd(node: unknown, offset: number): void
    }
    body: { append(node: unknown): void }
  }
  getSelection(): { removeAllRanges(): void; addRange(range: unknown): void } | null
}

const NOTE = [
  '---',
  'title: front matter is not a code block',
  '---',
  '',
  'Some `inline code` here.',
  '',
  '```html',
  '<b class="x">&amp; "quoted"</b>',
  '\tindented with a tab',
  '```',
  '',
  '```',
  'second block',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
].join('\n')

async function openNote(page: Page, body: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill('Code')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
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

test('each fenced code block has a copy button that copies its text as written', async ({
  page,
}) => {
  await openNote(page, NOTE)
  await expect(copyButtons(page)).toHaveCount(2)
  await expect(preview(page).locator('pre').first().getByRole('button')).toHaveCount(0)

  // Hidden until the block is pointed at (toBeVisible ignores opacity).
  await expect(copyButtons(page).first()).toHaveCSS('opacity', '0')
  await preview(page).locator('pre').first().hover()
  await expect(copyButtons(page).first()).toHaveCSS('opacity', '1')
  await copyButtons(page).first().click()
  await expect
    .poll(() => clipboardWrites(page))
    .toEqual(['<b class="x">&amp; "quoted"</b>\n\tindented with a tab'])
  await expect(preview(page).getByRole('button', { name: 'Copied' })).toHaveCount(1)
  await expect(preview(page).getByRole('button', { name: 'Copied' })).toHaveCount(0, {
    timeout: 4000,
  })
  await expect(copyButtons(page)).toHaveCount(2)

  await copyButtons(page).nth(1).click()
  await expect.poll(() => clipboardWrites(page)).toHaveLength(2)
  expect((await clipboardWrites(page))[1]).toBe('second block')
})

test('the button is reachable from the keyboard', async ({ page }) => {
  await openNote(page, '```\nkeyboard\n```')
  await expect(copyButtons(page)).toHaveCount(1)
  // A click on the code puts the keyboard there; Option+Tab goes on to the
  // button (WebKit on macOS tabs to buttons with Option, or with Full
  // Keyboard Access; elsewhere Tab alone does, with or without Alt). The
  // click is on the code, past the info card's date buttons above it.
  await preview(page)
    .locator('pre code')
    .click({ position: { x: 2, y: 2 } })
  // Away from the block, so only the keyboard focus can show the button.
  await page.mouse.move(0, 0)
  await expect(copyButtons(page)).toHaveCSS('opacity', '0')
  await page.keyboard.press('Alt+Tab')
  await expect(copyButtons(page)).toBeFocused()
  await expect(copyButtons(page)).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect.poll(() => clipboardWrites(page)).toEqual(['keyboard'])
  await expect(preview(page).getByRole('button', { name: 'Copied' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect.poll(() => clipboardWrites(page)).toEqual(['keyboard', 'keyboard'])
})

test('a failed copy says so', async ({ page }) => {
  await page.evaluate(() => {
    ;(globalThis as unknown as { devotIpcMocks: unknown }).devotIpcMocks = {
      clipboard_write_text: { error: 'E_CLIPBOARD_WRITE_FAILED' },
    }
  })
  await openNote(page, '```\nnope\n```')
  await copyButtons(page).click()
  await expect(preview(page).getByRole('button', { name: 'Could Not Copy' })).toBeVisible()
})

test('a long block goes through the native clipboard command too', async ({ page }) => {
  const long = 'x'.repeat(70 * 1024)
  await openNote(page, '```\n' + long + '\n```')
  await copyButtons(page).click()
  await expect(preview(page).getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await clipboardWrites(page)).toEqual([long])
})

test('the button stays while the block is edited and is never part of the note', async ({
  page,
}) => {
  await openNote(page, '```\nfirst\n```\n\nAfter.')
  const pre = preview(page).locator('pre')
  await expect(copyButtons(page)).toHaveCount(1)
  await copyButtons(page).evaluate((el) => Object.assign(el, { devotMark: true }))

  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\n\nMore text.')
  await expect(preview(page)).toContainText('More text.')
  expect(
    await copyButtons(page).evaluate((el) => (el as unknown as { devotMark?: boolean }).devotMark),
  ).toBe(true)
  await expect(pre.locator('code')).toHaveText('first\n')
  expect(await preview(page).evaluate((el) => el.textContent)).not.toContain('Copy')
  await expect(pre.locator('[data-devot-ui]')).toHaveCount(1)

  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+End')
  await page.keyboard.press('Backspace')
  await expect(pre).toHaveCount(1)
  await expect(copyButtons(page)).toHaveCount(0)
})

test('copying a selection across a block leaves the button out of the copied HTML', async ({
  page,
}) => {
  await openNote(page, 'Before the block.\n\n```\nselected code\n```\n\nAfter the block.')
  await expect(copyButtons(page)).toHaveCount(1)
  await page.evaluate(() => {
    const w = globalThis as unknown as PasteGlobals
    const target = w.document.createElement('div')
    target.contentEditable = 'true'
    target.setAttribute('aria-label', 'Paste target')
    target.style.setProperty('-webkit-user-select', 'text')
    target.style.setProperty('user-select', 'text')
    target.addEventListener('paste', (event) => {
      w.devotPastedHtml = event.clipboardData?.getData('text/html') ?? ''
    })
    w.document.body.append(target)
  })
  // Select from the paragraph before the block to the one after it.
  await preview(page).evaluate((article) => {
    const w = globalThis as unknown as PasteGlobals
    const paragraphs = article.querySelectorAll('p')
    const range = w.document.createRange()
    range.setStart(paragraphs[0]!.firstChild!, 0)
    range.setEnd(paragraphs[1]!.firstChild!, 'After'.length)
    const selection = w.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.keyboard.press('ControlOrMeta+C')
  await page.getByLabel('Paste target').focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.getByLabel('Paste target')).toContainText('selected code')
  const pasted = page.getByLabel('Paste target')
  await expect(pasted.locator('[data-devot-ui], .code-copy, button')).toHaveCount(0)
  const html = await page.evaluate(() => (globalThis as unknown as PasteGlobals).devotPastedHtml)
  expect(html).toContain('selected code')
  expect(html).not.toContain('data-devot-ui')
  expect(html).not.toContain('<button')
})

test('printing leaves the button out', async ({ page }) => {
  await openNote(page, '```\nprint me\n```')
  await expect(copyButtons(page)).toHaveCount(1)
  await page.emulateMedia({ media: 'print' })
  await expect(copyButtons(page)).toBeHidden()
  await expect(preview(page).locator('pre code')).toBeVisible()
})
