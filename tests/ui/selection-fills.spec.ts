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

test('a selected row is washed in the sidebar and the note list; both bar it when focused', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  const row = noteRows(page).first()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(allNotes(page)).toHaveAttribute('aria-current', 'true')

  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  const wash = await background(row)
  const sidebarWash = await background(allNotes(page))
  expect(wash).not.toBe('rgba(0, 0, 0, 0)')
  expect(sidebarWash).not.toBe('rgba(0, 0, 0, 0)')

  await row.click()
  await expect(row).toBeFocused()
  await expect.poll(() => background(row)).toBe(wash)
  await expect.poll(() => background(allNotes(page))).toBe(sidebarWash)

  await allNotes(page).focus()
  await expect.poll(() => background(allNotes(page))).toBe(sidebarWash)
  await expect(allNotes(page)).toHaveCSS('box-shadow', /^rgb.* 5px 0px 0px 0px inset$/)
  await expect.poll(() => background(row)).toBe(wash)
})
