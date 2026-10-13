// The rendered note takes the keyboard and scrolls with it, in Preview mode
// and in the Trash, and the font size keys (Cmd+=, Cmd+-, Cmd+0) resize it.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const trashRow = (page: Page) => sidebar(page).getByRole('button', { name: /^Trash \d+$/ })
const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const modeButton = (page: Page, name: string) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name, exact: true })

const paragraphs = (n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}`).join('\n\n')

async function longNote(page: Page, title: string) {
  await page.setViewportSize({ width: 1280, height: 600 })
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(`# Top heading\n\n${paragraphs(120)}`)
  await expect(page.locator('.cm-line').last()).toHaveText('Paragraph 120')
}

const scrollTop = (page: Page) => preview(page).evaluate((e) => e.scrollTop)
/** The scroll position once WebKit's scroll animation has come to rest. */
async function settledTop(page: Page) {
  let previous = -1
  await expect
    .poll(async () => {
      const top = await scrollTop(page)
      const rest = top === previous
      previous = top
      return rest
    })
    .toBe(true)
  return previous
}
async function pressUntilBeyond(page: Page, key: string, min: number) {
  await expect
    .poll(async () => {
      await page.keyboard.press(key)
      await page.waitForTimeout(150)
      return scrollTop(page)
    })
    .toBeGreaterThan(min)
}
const fontSize = (page: Page, selector: string) =>
  preview(page)
    .locator(selector)
    .first()
    .evaluate((e) =>
      Number.parseFloat(
        (
          globalThis as unknown as { getComputedStyle(el: unknown): { fontSize: string } }
        ).getComputedStyle(e).fontSize,
      ),
    )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Control+Tab reaches the preview in Preview mode, and the keys scroll it', async ({
  page,
}) => {
  await longNote(page, 'Long')
  await modeButton(page, 'Preview').click()
  await expect(preview(page).getByText('Paragraph 120', { exact: true })).toBeAttached()
  await sidebar(page)
    .getByRole('button', { name: /^All Notes/ })
    .focus()
  await page.keyboard.press('Control+Tab')
  await expect(noteRows(page).first()).toBeFocused()
  await page.keyboard.press('Control+Tab')
  await expect(preview(page)).toBeFocused()
  expect(await scrollTop(page)).toBe(0)
  await page.keyboard.press('PageDown')
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(200)
  const after = await settledTop(page)
  await expect(preview(page)).toBeFocused()
  // WebKit's scroll animation sometimes drops a key pressed just after
  // another scroll: press again until the page moves.
  await pressUntilBeyond(page, 'ArrowDown', after)
  // Page Down again: Home, End and Space scroll a focused region in WebKit on macOS
  // (the app's engine) but not in Playwright's WebKit on Linux, where only
  // the arrow keys and Page Up and Down do.
  const arrowed = await settledTop(page)
  await pressUntilBeyond(page, 'PageDown', arrowed + 200)
})

test('Control+Tab reaches the rendered note in the Trash, and the keys scroll it', async ({
  page,
}) => {
  await longNote(page, 'Long')
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(trashRow(page)).toHaveText(/1$/)
  await trashRow(page).click()
  await noteRows(page).first().click()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')
  await expect(preview(page).getByText('Paragraph 120', { exact: true })).toBeAttached()
  await noteRows(page).first().focus()
  await page.keyboard.press('Control+Tab')
  await expect(preview(page)).toBeFocused()
  await page.keyboard.press('PageDown')
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(200)
})

test('Tab reaches the preview from the Trash buttons, with a focus ring', async ({ page }) => {
  await longNote(page, 'Long')
  await page.getByRole('button', { name: 'Move to Trash' }).click()
  await trashRow(page).click()
  await noteRows(page).first().click()
  await expect(page.getByRole('status')).toContainText('This note is in the Trash.')
  await page.getByRole('button', { name: 'Delete Permanently' }).focus()
  await page.keyboard.press('Tab')
  await expect(preview(page)).toBeFocused()
  // Focus that came by Tab shows the ring; a click does not need it.
  await expect(preview(page)).not.toHaveCSS('box-shadow', 'none')
})

test('Cmd+= and Cmd+- resize the preview, and Cmd+0 resets it', async ({ page }) => {
  await longNote(page, 'Sized')
  await modeButton(page, 'Preview').click()
  await expect(preview(page).getByRole('heading', { name: 'Top heading' })).toBeVisible()
  const base = await fontSize(page, 'p')
  const heading = await fontSize(page, 'h1')
  await page.keyboard.press('Meta+Equal')
  // 13 to 14 px in the editor: the preview grows by the same ratio.
  await expect.poll(() => fontSize(page, 'p')).toBeCloseTo((base * 14) / 13, 1)
  await expect.poll(() => fontSize(page, 'h1')).toBeCloseTo((heading * 14) / 13, 1)
  await page.keyboard.press('Meta+Equal')
  await expect.poll(() => fontSize(page, 'p')).toBeCloseTo((base * 15) / 13, 1)
  await page.keyboard.press('Meta+Minus')
  await page.keyboard.press('Meta+Minus')
  await expect.poll(() => fontSize(page, 'p')).toBeCloseTo(base, 1)
  await page.keyboard.press('Meta+Equal')
  await page.keyboard.press('Meta+Digit0')
  await expect.poll(() => fontSize(page, 'p')).toBeCloseTo(base, 1)
})

test('Cmd+E swaps editor and preview, and Cmd+Shift+E shows both', async ({ page }) => {
  await longNote(page, 'Mode keys')
  const key = (k: string) => page.keyboard.press(`ControlOrMeta+${k}`)
  const pressed = async (name: 'Edit' | 'Split' | 'Preview') =>
    expect(modeButton(page, name)).toHaveAttribute('aria-pressed', 'true')

  await pressed('Edit')
  await key('KeyE')
  await pressed('Preview')
  await key('KeyE')
  await pressed('Edit')
  await key('Shift+KeyE')
  await pressed('Split')
  // From split, the pane with the keyboard stays: the editor has it here.
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await key('KeyE')
  await pressed('Edit')
})
