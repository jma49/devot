import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Write mode's rendered blocks (src/renderer/src/editor/write/rendered.ts): images, formulas and
// diagrams show as the preview shows them, and a closed one is one unit for the caret. The note's
// text is read through Edit mode, which shows every mark.

const FILE = 'devot://file/0192a6f0-0000-7000-8000-00000000f001'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const modes = (page: Page) => page.getByRole('group', { name: 'View mode' })

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

test.use({ install: 'new' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a formula is edited in place, under its rendering', async ({ page }) => {
  await createNote(page, 'Math', 'Before\n\n$$\nx^2\n$$\n\nAfter')
  const math = page.locator('.cm-wm-block-math')
  await expect(math.locator('math')).toHaveCount(1)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '', 'After'])

  await math.click()
  await expect(math).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '$$', 'x^2', '$$', '', 'After'])
  await page.keyboard.insertText(' + 1')
  await expect(math.locator('math')).toContainText('+ 1')

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(math).not.toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toEqual(['Before', '', '', 'After'])
  expect(await source(page)).toEqual(['Before', '', '$$', 'x^2 + 1', '$$', '', 'After'])
})

test('an image is stepped over, selected by Backspace and deleted by the next', async ({
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

  // Down from the line over the image lands on the line under it, at the same column.
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowDown')
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

test('a diagram shows drawn, and its source opens under it from a click', async ({ page }) => {
  await createNote(page, 'Chart', 'Intro\n\n```mermaid\ngraph TD\nA-->B\n```\n\nOutro')
  const diagram = page.locator('.cm-wm-block-diagram')
  await expect(diagram.locator('svg')).toHaveCount(1)
  await expect.poll(() => lines(page)).toEqual(['Intro', '', '', 'Outro'])
  await diagram.click()
  await expect(diagram).toHaveClass(/cm-wm-block-open/)
  await expect.poll(() => lines(page)).toContainEqual('graph TD')
  await expect(diagram.locator('svg')).toHaveCount(1)
})
