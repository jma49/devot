// The sidebar draws a selected row as an accent wash while it does not have
// the keyboard and a solid accent fill while it does; the note list keeps its
// wash either way and marks the open row with a bar while it has the keyboard.
import type { Locator, Page } from '@playwright/test'
import { light } from '../../src/renderer/src/theme/tokens'
import { expect, openApp, test } from './fixtures'

type Styles = { getComputedStyle(el: unknown): { getPropertyValue(p: string): string } }

const background = (locator: Locator) =>
  locator.evaluate((el) =>
    (globalThis as unknown as Styles).getComputedStyle(el).getPropertyValue('background-color'),
  )

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const allNotes = (page: Page) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^All Notes/ })

test('a selected row is washed in the sidebar and the note list; only the sidebar fills it when focused', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const row = noteRows(page).first()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')

  // The title field has the keyboard: both lists show the wash.
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  const wash = await background(row)
  const sidebarWash = await background(allNotes(page))
  expect(wash).not.toBe('rgba(0, 0, 0, 0)')
  expect(sidebarWash).not.toBe('rgba(0, 0, 0, 0)')

  // The note list has it: its selection keeps the wash, the sidebar's too.
  await row.click()
  await expect(row).toBeFocused()
  await expect.poll(() => background(row)).toBe(wash)
  await expect.poll(() => background(allNotes(page))).toBe(sidebarWash)

  // The sidebar has it: the accent fill there, the wash in the list.
  await allNotes(page).focus()
  await expect.poll(() => background(allNotes(page))).toBe(rgb(light['color.accent.fill']))
  await expect.poll(() => background(row)).toBe(wash)
})
