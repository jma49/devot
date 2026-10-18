import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function newNote(page: Page, title: string, body = '') {
  const before = await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(
    before + 1,
  )
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  if (body) {
    await page.getByRole('textbox', { name: 'Note body' }).click()
    await page.keyboard.insertText(body)
  }
}

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })
const card = (page: Page) => preview(page).getByRole('group', { name: 'Note info' })
const showPreview = (page: Page) =>
  page.getByRole('group', { name: 'View mode' }).getByRole('button', { name: 'Preview' }).click()

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('shows task progress and dates in the note info card', async ({ page }) => {
  await newNote(page, 'Chores', '- [x] dishes\n- [ ] laundry\n')
  await showPreview(page)
  await expect(card(page)).toContainText('Progress')
  await expect(card(page)).toContainText('1 of 2 tasks')
  await expect(card(page).locator('progress')).toHaveAttribute('max', '2')
  await expect(card(page).locator('time')).toHaveCount(2)
  await expect(card(page).locator('time').first()).toHaveText(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
  )
})

test('leaves Progress out for a note without tasks', async ({ page }) => {
  await newNote(page, 'Plain', 'Just words.')
  await showPreview(page)
  await expect(card(page)).toContainText('Created at')
  await expect(card(page)).not.toContainText('Progress')
})

test('a date on the card is edited in a date-time field: Return saves, Escape cancels', async ({
  page,
}) => {
  await newNote(page, 'Dated', 'Some text.')
  await showPreview(page)
  const created = card(page).locator('time[data-info="created"]')
  const updated = card(page).locator('time[data-info="updated"]')
  await expect(created).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  // The typed body is saved a moment later, which moves the update date (to
  // the second): read it once it has held for longer than a second.
  await expect
    .poll(async () => {
      const first = await updated.textContent()
      await page.waitForTimeout(1100)
      return first === (await updated.textContent())
    })
    .toBe(true)
  const updatedBefore = await updated.textContent()

  await created.click()
  const field = card(page).locator('input[data-info-edit="created"]')
  await expect(field).toBeFocused()
  await field.fill('2020-01-02T03:04:05')
  await page.keyboard.press('Enter')
  await expect(field).toHaveCount(0)
  await expect(created).toHaveText('2020-01-02 03:04:05')
  // Setting the creation date leaves the update date as it was.
  await expect(updated).toHaveText(updatedBefore ?? '')

  // Escape puts the date back and writes nothing.
  await updated.click()
  const other = card(page).locator('input[data-info-edit="updated"]')
  await other.fill('2021-05-06T07:08:09')
  await page.keyboard.press('Escape')
  await expect(other).toHaveCount(0)
  await expect(updated).toHaveText(updatedBefore ?? '')
  await expect(created).toHaveText('2020-01-02 03:04:05')
})
