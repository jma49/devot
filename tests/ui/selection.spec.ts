import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

type Box = { x: number; y: number; width: number; height: number }

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const line = (page: Page, n: number) => page.locator('.cm-line').nth(n - 1)

function selectionRects(page: Page): Promise<(Box & { fill: string })[]> {
  return page.locator('.cm-selectionBackground').evaluateAll((rects) =>
    rects.map((rect) => {
      const el = rect as unknown as { getBoundingClientRect(): Box }
      const view = globalThis as unknown as {
        getComputedStyle(e: unknown): { backgroundColor: string }
      }
      const { x, y, width, height } = el.getBoundingClientRect()
      return { x, y, width, height, fill: view.getComputedStyle(rect).backgroundColor }
    }),
  )
}

const onLine = (rects: (Box & { fill: string })[], box: Box) =>
  rects.filter(
    (r) => r.height > 0 && r.y + r.height / 2 > box.y && r.y + r.height / 2 < box.y + box.height,
  )

async function expectBothLinesSelected(page: Page, caretX: number): Promise<string> {
  const empty = (await line(page, 2).boundingBox())!
  const next = (await line(page, 3).boundingBox())!
  await expect.poll(async () => onLine(await selectionRects(page), next).length).toBeGreaterThan(0)
  const rects = await selectionRects(page)
  const [emptyRect] = onLine(rects, empty)
  const [nextRect] = onLine(rects, next)
  expect(emptyRect).toBeDefined()
  expect(emptyRect!.x + emptyRect!.width).toBeGreaterThan(empty.x + empty.width / 2)
  expect(nextRect).toBeDefined()
  expect(nextRect!.x).toBeLessThan(next.x + 10)
  expect(nextRect!.x + nextRect!.width).toBeGreaterThanOrEqual(caretX - 1)
  expect(nextRect!.fill).toBe(emptyRect!.fill)
  expect(nextRect!.fill).not.toMatch(/rgba\(.*,\s*0\)|transparent/)
  return nextRect!.fill
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`in ${colorScheme}`, () => {
    test.use({ colorScheme })

    test('a selection from the end of an empty line shows on the next line too, focused or not', async ({
      page,
    }) => {
      await page.goto('/')
      await page.getByRole('button', { name: 'New Note', exact: true }).click()
      await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
      await body(page).click()
      await page.keyboard.insertText('first\n\nhello world')
      await expect(page.locator('.cm-line')).toHaveCount(3)

      const empty = (await line(page, 2).boundingBox())!
      await page.mouse.click(empty.x + 4, empty.y + empty.height / 2)
      await page.keyboard.press('Shift+ArrowDown')
      for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')
      const caret = (await page.locator('.cm-cursor-primary').boundingBox())!
      const focused = await expectBothLinesSelected(page, caret.x)

      // The editor loses focus: the selection stays on both lines, in its lighter fill.
      await page.getByRole('textbox', { name: 'Title' }).focus()
      await expect.poll(async () => (await selectionRects(page))[0]?.fill).not.toBe(focused)
      await expectBothLinesSelected(page, caret.x)
    })
  })
}
