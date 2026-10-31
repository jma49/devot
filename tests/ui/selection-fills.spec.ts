import type { Locator, Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

type Styles = { getComputedStyle(el: unknown): { getPropertyValue(p: string): string } }

const background = (locator: Locator) =>
  locator.evaluate((el) =>
    (globalThis as unknown as Styles).getComputedStyle(el).getPropertyValue('background-color'),
  )

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const allNotes = (page: Page) =>
  page.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', { name: /^All Notes/ })

test('a selected row is washed in the accent in the pane with the keyboard, neutral elsewhere', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const row = noteRows(page).first()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')

  // The title field has the keyboard: neither list does, so both draw the neutral fill.
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  const neutral = await background(row)
  expect(neutral).not.toBe('rgba(0, 0, 0, 0)')
  await expect.poll(() => background(allNotes(page))).toBe(neutral)

  // The note list has it: its selection takes the accent wash, the sidebar's stays neutral.
  await row.click()
  await expect(row).toBeFocused()
  await expect.poll(() => background(row)).not.toBe(neutral)
  await expect.poll(() => background(allNotes(page))).toBe(neutral)

  // The sidebar has it: its accent wash and the bar; the list goes neutral.
  await allNotes(page).focus()
  await expect.poll(() => background(allNotes(page))).not.toBe(neutral)
  await expect(allNotes(page)).toHaveCSS('box-shadow', /^rgb.* 5px 0px 0px 0px inset$/)
  await expect.poll(() => background(row)).toBe(neutral)
})
