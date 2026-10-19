import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

/** size.pane-min-width */
const PANE_MIN = 240

type Box = { x: number; y: number; width: number; height: number }

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const showSidebar = (page: Page) => page.getByRole('button', { name: 'Show Sidebar' })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })
const format = (page: Page) => page.getByRole('toolbar', { name: 'Format' })

async function box(locator: ReturnType<Page['locator']>): Promise<Box> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('E_TEST_NOT_VISIBLE')
  return b
}

async function openNote(page: Page, width: number, text: string) {
  await page.setViewportSize({ width, height: 700 })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

for (const width of [760, 800, 900]) {
  test(`the editor toolbar and the split panes fit a ${width} px window`, async ({ page }) => {
    await openNote(page, width, 'alpha beta gamma delta')
    await mode(page, 'Split').click()

    await expect(sidebar(page)).toBeHidden()
    await expect(showSidebar(page)).toBeVisible()

    const toolbar = page.locator('.editor-toolbar')
    const controls = toolbar.locator('button')
    const count = await controls.count()
    expect(count).toBeGreaterThanOrEqual(7)
    for (let i = 0; i < count; i += 1) {
      const b = await box(controls.nth(i))
      expect(b.x, `control ${i} starts inside`).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width, `control ${i} ends inside`).toBeLessThanOrEqual(width)
      expect(b.width, `control ${i} keeps a width`).toBeGreaterThan(20)
    }
    const clipped = await toolbar.evaluate(
      (el) => (el as unknown as { scrollWidth: number; clientWidth: number }).scrollWidth,
    )
    expect(clipped).toBeLessThanOrEqual((await box(toolbar)).width)
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
            .document.documentElement.scrollWidth,
      ),
    ).toBeLessThanOrEqual(width)

    const editor = await box(page.locator('[data-devot-part=editor-body]'))
    const preview = await box(page.getByRole('article', { name: 'Preview' }))
    expect(editor.width).toBeGreaterThanOrEqual(PANE_MIN)
    expect(preview.width).toBeGreaterThanOrEqual(PANE_MIN)
    expect(preview.x + preview.width).toBeLessThanOrEqual(width)
    expect(preview.x).toBeGreaterThanOrEqual(editor.x + editor.width - 1)
  })

  test(`the selection toolbar stays on one row in split mode (${width} px)`, async ({ page }) => {
    await openNote(page, width, 'alpha beta gamma delta')
    await mode(page, 'Split').click()
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(format(page)).toBeVisible()

    const buttons = format(page).getByRole('button')
    const count = await buttons.count()
    expect(count).toBe(13)
    const editor = await box(page.locator('[data-devot-part=editor-body]'))
    // CodeMirror places it in the next frames: wait until it is inside the pane.
    await expect
      .poll(async () => {
        const b = await box(format(page))
        return b.x >= editor.x - 1 && b.x + b.width <= editor.x + editor.width + 1
      })
      .toBe(true)
    const bar = await box(format(page))
    const first = await box(buttons.first())
    for (let i = 0; i < count; i += 1) {
      expect(
        Math.abs((await box(buttons.nth(i))).y - first.y),
        `button ${i} on the row`,
      ).toBeLessThan(2)
    }
    expect(bar.height).toBeLessThan(first.height * 1.5)
    await format(page).getByRole('button', { name: 'Quote' }).click()
    await expect(page.locator('.cm-line')).toHaveText('> alpha beta gamma delta')
  })
}

test('the sidebar shows at 1000 px, gives way below it, and comes back on request', async ({
  page,
}) => {
  await openNote(page, 1000, 'note')
  await expect(sidebar(page)).toBeVisible()
  await expect(showSidebar(page)).toBeHidden()

  await page.setViewportSize({ width: 999, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()

  await showSidebar(page).click()
  await expect(sidebar(page)).toBeVisible()
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(sidebar(page)).toBeHidden()

  // A wide window shows it again: the narrow window's choice was not saved.
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeVisible()
  await page.reload()
  await expect(sidebar(page)).toBeVisible()
})

test('a sidebar asked for in a narrow window is hidden again after a trip through a wide one', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  await showSidebar(page).click()
  await expect(sidebar(page)).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeVisible()
  // The window has rendered as a wide one before it narrows again.
  await expect(page.locator('.window')).not.toHaveAttribute('data-narrow')
  await page.setViewportSize({ width: 800, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()
})

test('a sidebar the user hid stays hidden in a wide window', async ({ page }) => {
  await openNote(page, 1280, 'note')
  await page.getByRole('button', { name: 'Hide Sidebar' }).click()
  await expect(sidebar(page)).toBeHidden()
  await page.setViewportSize({ width: 800, height: 700 })
  await page.setViewportSize({ width: 1280, height: 700 })
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()
})

test('a window narrower than 1000 px opens without the sidebar', async ({ page }) => {
  await openNote(page, 800, 'note')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible()
  await expect(sidebar(page)).toBeHidden()
  await expect(showSidebar(page)).toBeVisible()
})

test('Cmd+/ shows the sidebar in a narrow window, which then fits without scrolling sideways', async ({
  page,
}) => {
  await openNote(page, 800, 'note')
  await expect(sidebar(page)).toBeHidden()
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('region', { name: 'Notes' })).toBeVisible()
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
          .document.documentElement.scrollWidth,
    ),
  ).toBeLessThanOrEqual(800)
  await page.keyboard.press('Meta+Slash')
  await expect(sidebar(page)).toBeHidden()
})
