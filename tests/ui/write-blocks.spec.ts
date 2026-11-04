import type { Locator, Page } from '@playwright/test'
import { expect, test, openApp } from './fixtures'

// Write mode's rendered blocks (src/renderer/src/editor/write/rendered.ts): images, formulas and
// diagrams show as the preview shows them, a caret in one shows its source over the rendering, and
// the arrows enter it. The note's text is read through Edit mode, which shows every mark.

const FILE = 'devot://file/0192a6f0-0000-7000-8000-00000000f001'
const REMOTE = 'https://images.test/write/plan.svg'
const REMOTE_SIZE = { width: 1200, height: 600 }

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const modes = (page: Page) => page.getByRole('group', { name: 'View mode' })
const writeButton = (page: Page) =>
  page.locator('.editor-toolbar').getByRole('button', { name: 'Write Mode', exact: true })
const viewer = (page: Page) => page.getByRole('dialog', { name: /^Image Viewer/ })

/** Whether the bottom of `upper` is at or above the top of `lower`. */
async function isOver(upper: Locator, lower: Locator): Promise<boolean> {
  const a = await upper.boundingBox()
  const b = await lower.boundingBox()
  return a !== null && b !== null && a.y + a.height <= b.y + 1
}

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

test.use({ install: 'new' })

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('a formula shows its source over its rendering while the caret is in it', async ({ page }) => {
  await createNote(page, 'Math', 'Before\n\n$$\nx^2\n$$\n\nAfter')
  const math = page.locator('.cm-wm-block-math')
  await expect(math.locator('math')).toHaveCount(1)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '', 'After'])

  await math.click()
  await expect(math).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '$$', 'x^2', '$$', '', 'After'])
  expect(await isOver(page.locator('.cm-line', { hasText: /^\$\$$/ }).last(), math)).toBe(true)
  await page.keyboard.insertText(' + 1')
  await expect(math.locator('math')).toContainText('+ 1')

  // Down leaves the source by its last line and the rendering stays.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(math).not.toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '', 'After'])

  // Up from under it enters its source at the end: one Down leaves it again.
  await page.keyboard.press('ArrowUp')
  await expect(math).toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ArrowDown')
  await expect(math).not.toHaveClass(/cm-wm-block-open/)

  // Down from over it enters its source at the start: one Up leaves it again.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ArrowDown')
  await expect(math).not.toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ArrowDown')
  await expect(math).toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ArrowUp')
  await expect(math).not.toHaveClass(/cm-wm-block-open/)
  expect(await source(page)).toEqual(['Before', '', '$$', 'x^2 + 1', '$$', '', 'After'])
})

test('an image shows its Markdown over it from a click, and opens on a double click', async ({
  page,
}) => {
  await page.route(REMOTE, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${REMOTE_SIZE.width}" height="${REMOTE_SIZE.height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
    }),
  )
  await createNote(page, 'Remote', `Top\n![Plan](${REMOTE})\nEnd`)
  const image = page.locator('.cm-wm-block-image')
  const img = image.locator('img')
  await expect
    .poll(() => img.evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth))
    .toBe(REMOTE_SIZE.width)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End'])

  await img.click()
  await expect(image).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Top', `![Plan](${REMOTE})`, 'End'])
  await expect(img).toHaveCount(1)
  expect(await isOver(page.locator('.cm-line').nth(1), image)).toBe(true)
  await expect(viewer(page)).toBeHidden()
  // The click put the caret at the end of the alt text.
  await page.keyboard.insertText(' map')
  await expect.poll(() => lines(page)).toEqual(['Top', `![Plan map](${REMOTE})`, 'End'])

  // An image whose source shows opens too.
  await img.dblclick()
  await expect(viewer(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()

  await page.locator('.cm-line', { hasText: 'End' }).click()
  await expect(image).not.toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End'])

  // Near its top, so the second click lands on the source the first one showed over it.
  await img.dblclick({ position: { x: 40, y: 4 } })
  await expect(viewer(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
})

test('an image is entered by the arrows, selected by Backspace and deleted by the next', async ({
  page,
}) => {
  await createNote(page, 'Picture', `Top\n![Plan](${FILE})\nEnd`)
  const image = page.locator('.cm-wm-block-image')
  await expect(image.locator('img')).toHaveCount(1)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End'])

  // A copy of a selection across the image is its Markdown.
  await page.keyboard.press('ControlOrMeta+a')
  await expect(image).toHaveClass(/cm-wm-block-selected/)
  const copied = await body(page).evaluate((content) => {
    // This config has no DOM types: the few browser classes used here.
    const w = globalThis as unknown as {
      DataTransfer: new () => { getData(type: string): string }
      ClipboardEvent: new (type: string, init: object) => unknown
    }
    const data = new w.DataTransfer()
    ;(content as unknown as { dispatchEvent(e: unknown): boolean }).dispatchEvent(
      new w.ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return data.getData('text/plain')
  })
  expect(copied).toBe(`Top\n![Plan](${FILE})\nEnd`)

  // Down from the line over the image enters its Markdown; the next Down leaves it.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
  await expect(image).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Top', `![Plan](${FILE})`, 'End'])
  await page.keyboard.press('ArrowDown')
  await expect(image).not.toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowRight')
  await expect(image).toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ArrowLeft')
  await expect(image).not.toHaveClass(/cm-wm-block-open/)
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('!')
  await expect.poll(() => lines(page)).toEqual(['Top', 'End!'])

  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  await expect(image).toHaveClass(/cm-wm-block-selected/)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End!'])
  await page.keyboard.press('Backspace')
  await expect(image).toHaveCount(0)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End!'])
  expect(await source(page)).toEqual(['Top', 'End!'])
})

test('a diagram shows drawn, and a click shows its source over it', async ({ page }) => {
  await createNote(page, 'Chart', 'Intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\nOutro')
  const diagram = page.locator('.cm-wm-block-diagram')
  await expect(diagram.locator('svg')).toHaveCount(1)
  await expect.poll(() => lines(page)).toEqual(['Intro', '', '', 'Outro'])
  await diagram.click()
  await expect(diagram).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toContainEqual('graph TD')
  await expect(diagram.locator('svg')).toHaveCount(1)
  expect(await isOver(page.locator('.cm-line', { hasText: /^```$/ }), diagram)).toBe(true)
})

const tops = (page: Page) =>
  page
    .locator('.cm-line')
    .evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().y)))

test('a code block hides its fences, keeping their lines, and names its language', async ({
  page,
}) => {
  const text = ['Before', '', '```ts', 'const answer = 42', '```', '', 'After']
  await createNote(page, 'Code', text.join('\n'))
  await expect
    .poll(() => lines(page))
    .toEqual(['Before', '', 'TypeScript', 'const answer = 42', '', '', 'After'])
  const language = page.locator('.cm-wm-code-language')
  await expect(language).toHaveCSS('font-size', '11px')
  await expect(language).toHaveCSS('position', 'absolute')
  const box = (await page.locator('.cm-line.cm-codeblock-first').boundingBox())!
  const label = (await language.boundingBox())!
  expect(label.x + label.width).toBeGreaterThan(box.x + box.width / 2)
  const before = await tops(page)

  await page.locator('.cm-line', { hasText: 'const answer' }).click()
  await expect.poll(() => lines(page)).toEqual(text)
  await expect(language).toHaveCount(0)
  expect(await tops(page)).toEqual(before)
  await page.locator('.cm-line', { hasText: 'After' }).click()
  await expect(language).toHaveCount(1)
  expect(await source(page)).toEqual(text)
})

test('an alert reads upright with its title in its colour; a plain quote stays italic', async ({
  page,
}) => {
  await createNote(page, 'Alert', '> [!NOTE]\n> An alert with a *slant*.\n\n> A plain quote\n\nEnd')
  const label = page.locator('.cm-wm-alert-label')
  await expect(label).toHaveText('Note')
  await expect(label).toHaveCSS('font-weight', '600')
  const alertText = page.locator('.cm-md-alert span', { hasText: 'An alert with' }).first()
  await expect(alertText).toHaveCSS('font-style', 'normal')
  await expect(page.locator('.cm-md-alert span', { hasText: /^slant$/ })).toHaveCSS(
    'font-style',
    'italic',
  )
  const quoteText = page.locator('.cm-md-quote:not(.cm-md-alert) span', { hasText: 'plain' })
  await expect(quoteText.first()).toHaveCSS('font-style', 'italic')
  const colour = (el: Locator) => el.evaluate((e) => getComputedStyle(e).color)
  expect(await colour(label)).not.toBe(await colour(alertText))
  expect(await colour(alertText)).not.toBe(await colour(quoteText.first()))
})

test('an image that does not load shows the block placeholder with its alt text', async ({
  page,
}) => {
  const broken = 'https://images.test/write/missing.png'
  await page.route(broken, (route) => route.fulfill({ status: 404, body: '' }))
  await createNote(page, 'Broken', `Top\n![Site plan](${broken})\nEnd`)
  const image = page.locator('.cm-wm-block-image')
  const img = image.locator('img')
  await expect(img).toHaveClass(/image-missing/)
  await expect(img).toHaveAttribute('aria-label', 'Site plan: image could not be loaded')
  await expect(image.locator('p')).toHaveAttribute('data-image-missing-alt', 'Site plan')
  expect(await img.evaluate((el) => getComputedStyle(el).content)).toContain('data:image/gif')
  const lineHeight = await img.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
  expect((await img.boundingBox())!.height).toBeCloseTo(3 * lineHeight, 0)
  await expect.poll(() => lines(page)).toEqual(['Top', 'End'])

  await img.click()
  await expect(image).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Top', `![Site plan](${broken})`, 'End'])
  await expect(viewer(page)).toBeHidden()
})
