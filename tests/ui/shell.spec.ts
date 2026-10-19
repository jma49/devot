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
      .match(/(?:rgba?|color)\(([^)]*)\)/)?.[1]
      ?.split(/[\s,/]+/)
      .filter(Boolean) ?? []
  // rgb(r g b / a) or color(srgb r g b / a)
  const channels = parts[0] === 'srgb' ? parts.slice(1) : parts
  return channels.length === 4 ? Number(channels[3]) : 1
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

  expect((await sidebar.boundingBox())?.width).toBe(200)
  expect((await list.boundingBox())?.width).toBe(300)
  expect(await css(page.locator('body'), 'font-size')).toBe('13px')

  const allNotes = sidebar.getByRole('button', { name: /All Notes/ })
  expect((await allNotes.boundingBox())?.height).toBe(30)
  await expect(allNotes).toHaveAttribute('aria-current', 'true')
  const count = allNotes.locator('.source-count')
  expect(await css(count, 'font-size')).toBe('10px')
  expect(await css(count, 'font-weight')).toBe('200')
  expect(await css(count, 'opacity')).toBe('0.6')

  const field = list.locator('.search-field')
  expect((await field.boundingBox())?.height).toBe(30)
  await expect(field.locator('.search-icon')).toHaveCount(1)
  expect((await field.locator('.search-icon').boundingBox())?.width).toBeCloseTo(37.4, 0)
  await field.locator('input').fill('x')
  await expect(field.locator('.search-icon')).toHaveCount(0)
  await expect(field.getByRole('button', { name: 'Clear search' })).toBeVisible()
  expect(await css(field.locator('input'), 'padding-left')).toBe('8px')
  await field.locator('input').fill('')

  const bars = page.locator('[data-devot-part=toolbar], [data-devot-part=sidebar-titlebar]')
  await expect(bars).toHaveCount(3)
  for (const bar of await bars.all()) {
    expect((await bar.boundingBox())?.height).toBe(52)
    await expect(bar).toHaveAttribute('data-tauri-drag-region')
  }
})

test('the sidebar, list and editor show the window material through their washes', async ({
  page,
}) => {
  await freshStart(page)
  const sidebar = page.getByRole('navigation', { name: 'Sidebar' })
  expect(alpha(await css(sidebar, 'background-color'))).toBeLessThan(1)
  expect(
    alpha(await css(page.getByRole('region', { name: 'Notes' }), 'background-color')),
  ).toBeLessThan(1)
  expect(alpha(await css(page.getByRole('main'), 'background-color'))).toBeLessThan(1)
})

test('counts notes in the sidebar and for the note list', async ({ page }) => {
  await freshStart(page)
  await expect(page.locator('.list .list-count')).toHaveText('0 notes')
  await createNote(page, 'First')
  await expect(page.locator('.list .list-count')).toHaveText('1 note')
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
  await expect.poll(requests).toContain('note.text@14')
  const once = await requests()
  expect(once.filter((r) => r === 'square.and.pencil@18')).toHaveLength(1)

  // A new appearance renders again; returning to a seen one uses the cache.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect
    .poll(async () => (await requests()).filter((r) => r === 'square.and.pencil@18'))
    .toHaveLength(2)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(100)
  expect((await requests()).filter((r) => r === 'square.and.pencil@18')).toHaveLength(2)
})

test('the note list selection is an accent wash, with a bar on the open row while the list has the keyboard', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await freshStart(page)
  await createNote(page, 'Alpha')
  await createNote(page, 'Beta')

  const rows = page.getByRole('listbox', { name: 'Notes' })
  const beta = rows.getByRole('option', { name: /Beta/ })
  const alphaRow = rows.getByRole('option', { name: /Alpha/ })
  await expect(beta).toHaveAttribute('aria-selected', 'true')

  const wash = await css(beta, 'background-color')
  expect(alpha(wash)).toBeCloseTo(0.2, 2)
  expect(await css(beta, 'box-shadow')).toBe('none')
  const text = await css(beta, 'color')

  await beta.click()
  await expect(beta).toBeFocused()
  await expect
    .poll(() => css(beta, 'box-shadow'))
    .toBe(`${rgb(light['color.accent.fill'])} 5px 0px 0px 0px inset`)
  expect(await css(beta, 'background-color')).toBe(wash)
  expect(await css(beta, 'color')).toBe(text)
  expect(await css(alphaRow, 'box-shadow')).toBe('none')

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

test('the selected view mode is a neutral grey segment', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await freshStart(page)
  await createNote(page, 'Modes')
  const split = page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
  await split.click()
  await expect(split).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => css(split, 'background-color')).toBe('rgba(28, 27, 25, 0.12)')
})

test('the window stays put while the caret scrolls to the end of a long note', async ({ page }) => {
  await freshStart(page)
  await createNote(page, 'Long')
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  await body.fill(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'))
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible()
  const scrolled = () =>
    page.evaluate(() => {
      const doc = (
        globalThis as unknown as {
          document: {
            documentElement: { scrollTop: number }
            body: { scrollTop: number }
          }
        }
      ).document
      return doc.documentElement.scrollTop + doc.body.scrollTop
    })
  expect(await scrolled()).toBe(0)
})
