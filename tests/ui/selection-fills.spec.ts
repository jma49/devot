// The sidebar and the note list draw a selected row the same way: an accent
// wash while the list does not have the keyboard, a solid accent fill with
// the on-fill text while it does.
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

test('a selected row has the same fill in the sidebar and the note list, focused or not', async ({
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
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  const wash = await background(row)
  expect(wash).not.toBe('rgba(0, 0, 0, 0)')
  expect(await background(allNotes(page))).toBe(wash)

  // The note list has it: its selection is the accent fill, the sidebar's stays washed.
  await row.click()
  await expect(row).toBeFocused()
  await expect.poll(() => background(row)).toBe(rgb(light['color.accent.fill']))
  await expect.poll(() => background(allNotes(page))).toBe(wash)

  // The sidebar has it: the same accent fill there, the wash in the list.
  await allNotes(page).focus()
  await expect.poll(() => background(allNotes(page))).toBe(rgb(light['color.accent.fill']))
  await expect.poll(() => background(row)).toBe(wash)
})
