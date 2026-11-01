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

test('the note list selection is the accent wash and the sidebar selection neutral, wherever the keyboard is', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const row = noteRows(page).first()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')

  // Wherever the keyboard is, the note list's selection is the accent wash and the sidebar's is neutral.
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  const wash = await background(row)
  const neutral = await background(allNotes(page))
  expect(neutral).not.toBe('rgba(0, 0, 0, 0)')
  expect(wash).not.toBe(neutral)

  await row.click()
  await expect(row).toBeFocused()
  await expect.poll(() => background(row)).toBe(wash)
  await expect.poll(() => background(allNotes(page))).toBe(neutral)

  await allNotes(page).focus()
  await expect.poll(() => background(allNotes(page))).toBe(neutral)
  await expect(allNotes(page)).toHaveCSS('box-shadow', 'none')
  await expect.poll(() => background(row)).toBe(wash)
})
