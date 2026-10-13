import type { Locator, Page } from '@playwright/test'
import { light } from '../../src/renderer/src/theme/tokens'
import { expect, symbolRequests, test, type TestWindow } from './fixtures'

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

type Styles = { getComputedStyle(el: unknown): { getPropertyValue(p: string): string } }

const css = (locator: Locator, property: string) =>
  locator.evaluate(
    (el, p) => (globalThis as unknown as Styles).getComputedStyle(el).getPropertyValue(p),
    property,
  )

const alpha = (color: string) => {
  const parts =
    color
      .match(/rgba?\(([^)]*)\)/)?.[1]
      ?.split(/[\s,/]+/)
      .filter(Boolean) ?? []
  return parts.length === 4 ? Number(parts[3]) : 1
}

async function freshStart(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function createNote(page: Page, title: string) {
  const before = await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  // Wait for the new note to open, or the title lands on the previous one.
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(
    before + 1,
  )
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
}

test('lays out sidebar, note list and editor at the macOS type scale', async ({ page }) => {
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  const list = page.getByRole('region', { name: 'Notes' })
  const editor = page.getByRole('main')
  await expect(sidebar).toBeVisible()
  await expect(list).toBeVisible()
  await expect(editor).toBeVisible()

  expect((await sidebar.boundingBox())?.width).toBe(232)
  expect((await list.boundingBox())?.width).toBe(320)
  expect(await css(page.locator('body'), 'font-size')).toBe('13px')

  const allNotes = sidebar.getByRole('button', { name: /All Notes/ })
  expect((await allNotes.boundingBox())?.height).toBe(28)
  await expect(allNotes).toHaveAttribute('aria-current', 'true')

  // The unified toolbar over list and editor, and the sidebar's title bar.
  const bars = page.locator('[data-devot-part=toolbar], [data-devot-part=sidebar-titlebar]')
  await expect(bars).toHaveCount(3)
  for (const bar of await bars.all()) {
    expect((await bar.boundingBox())?.height).toBe(52)
    await expect(bar).toHaveAttribute('data-tauri-drag-region')
  }
})

test('the sidebar shows the window material; list and editor are opaque', async ({ page }) => {
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  expect(alpha(await css(sidebar, 'background-color'))).toBeLessThan(1)
  expect(alpha(await css(page.getByRole('region', { name: 'Notes' }), 'background-color'))).toBe(1)
  expect(alpha(await css(page.getByRole('main'), 'background-color'))).toBe(1)
})

test('counts notes in the sidebar and the list header', async ({ page }) => {
  await freshStart(page)
  await expect(page.getByText('0 notes')).toBeVisible()
  await createNote(page, 'First')
  await expect(page.getByText('1 note', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /All Notes/ })).toContainText('1')
})

test('icons are SF Symbols, cached per name, size and appearance', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await freshStart(page)
  const newNote = page.getByRole('button', { name: 'New Note', exact: true })
  const icon = newNote.locator('[data-symbol]')
  await expect(icon).toHaveAttribute('data-symbol', 'square.and.pencil')
  await expect.poll(() => css(icon, '-webkit-mask-image')).toContain('data:image/png;base64,')
  // The symbol is black; the theme colours it.
  expect(await css(icon, 'background-color')).toBe(await css(newNote, 'color'))

  const requests = () =>
    page.evaluate(() => (globalThis as unknown as TestWindow).devotIpcCalls).then(symbolRequests)
  await expect.poll(requests).toContain('note.text@17')
  const once = await requests()
  expect(once.filter((r) => r === 'square.and.pencil@17')).toHaveLength(1)

  // A new appearance renders again; returning to a seen one uses the cache.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(async () => (await requests()).filter((r) => r === 'square.and.pencil@17'))
    .toHaveLength(2)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(100)
  expect((await requests()).filter((r) => r === 'square.and.pencil@17')).toHaveLength(2)
})

test('the note list selection stays neutral, focused or not', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await freshStart(page)
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')

  const rows = page.getByRole('listbox', { name: 'Notes' })
  const beta = rows.getByRole('option', { name: /Beta/ })
  const alphaRow = rows.getByRole('option', { name: /Alpha/ })
  await expect(beta).toHaveAttribute('aria-selected', 'true')

  // Typing in the title: the list is not focused.
  await expect.poll(() => css(beta, 'background-color')).toBe('rgba(28, 27, 25, 0.075)')

  await beta.click()
  await expect(beta).toBeFocused()
  // Focused: still neutral (only the sidebar shows the accent).
  expect(await css(beta, 'background-color')).toBe('rgba(28, 27, 25, 0.075)')
  expect(await css(beta, 'color')).not.toBe(rgb(light['color.accent.on-fill']))

  // Arrow keys move the selection and open the note.
  await page.keyboard.press('ArrowDown')
  await expect(alphaRow).toHaveAttribute('aria-selected', 'true')
  await expect(alphaRow).toBeFocused()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Alpha')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Beta')
})

test('coded console warnings reach the local log without other arguments', async ({ page }) => {
  await freshStart(page)
  const id = '01920000-0000-7000-8000-000000000001'
  await page.evaluate((noteId) => console.warn('W_UI_TEST', noteId, 'Private title'), id)
  const logged = () =>
    page.evaluate(() =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter((c) => c.cmd === 'log_write'),
    )
  await expect
    .poll(async () => (await logged()).map((c) => c.args))
    .toContainEqual({ level: 'warn', code: 'W_UI_TEST', ids: [id] })
})
