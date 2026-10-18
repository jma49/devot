import type { Page } from '@playwright/test'
import { clipboardWrites, expect, pickMenuItem, shownMenu, test, type TestWindow } from './fixtures'

// The preview's native menu: a right-click in the rendered note.

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const mode = (page: Page, name: 'Edit' | 'Split' | 'Preview') =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name })

const popups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

async function newNote(page: Page, title: string, body: string) {
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  const before = await rows.count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(rows).toHaveCount(before + 1)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
}

test.beforeEach(async ({ page }) => {
  await page.route(/^https:\/\//, (route) => route.abort())
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a right-click on text shows Copy, Select All and Speech', async ({ page }) => {
  await newNote(page, 'Plain', 'Just some words here.')
  await mode(page, 'Split').click()
  const before = await popups(page)
  await preview(page).getByText('Just some words here.').click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect(await shownMenu(page)).toEqual([
    'Copy',
    'Select All',
    '---',
    'Speech >',
    '  Start Speaking',
    '  Stop Speaking',
  ])
})

test('a link offers Copy Link Address', async ({ page }) => {
  await newNote(page, 'Links', 'Visit [the site](https://example.com/page).')
  await mode(page, 'Split').click()
  const before = await popups(page)
  await preview(page).getByRole('link', { name: 'the site' }).click({ button: 'right' })
  await expect.poll(() => popups(page)).toBe(before + 1)
  expect((await shownMenu(page)).slice(0, 2)).toEqual(['Copy Link Address', '---'])
  await pickMenuItem(page, 'Copy Link Address')
  await expect.poll(() => clipboardWrites(page)).toEqual(['https://example.com/page'])
  // The right-click did not open the link.
  const opened = await page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls.some((c) => c.cmd === 'open_external'),
  )
  expect(opened).toBe(false)
})

test('Select All selects the preview alone', async ({ page }) => {
  await newNote(page, 'Scope', 'Only this text.')
  await mode(page, 'Split').click()
  await preview(page).getByText('Only this text.').click({ button: 'right' })
  await pickMenuItem(page, 'Select All')
  const selected = await page.evaluate(() =>
    (globalThis as unknown as { getSelection(): { toString(): string } }).getSelection().toString(),
  )
  expect(selected).toContain('Only this text.')
  expect(selected).not.toContain('New Note')
})
