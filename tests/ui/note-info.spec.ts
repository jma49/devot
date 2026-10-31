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
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}(?: at|,) \d{1,2}:\d{2}\s[AP]M$/,
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
  await expect(created).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}(?: at|,) \d{1,2}:\d{2}\s[AP]M$/)
  // The typed body saves a moment later and moves the update date (to the second): read it once it has held for over a second.
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
  await expect(created).toHaveText(/^Jan 2, 2020(?: at|,) 3:04\sAM$/)
  await expect(updated).toHaveText(updatedBefore ?? '')

  await updated.click()
  const other = card(page).locator('input[data-info-edit="updated"]')
  await other.fill('2021-05-06T07:08:09')
  await page.keyboard.press('Escape')
  await expect(other).toHaveCount(0)
  await expect(updated).toHaveText(updatedBefore ?? '')
  await expect(created).toHaveText(/^Jan 2, 2020(?: at|,) 3:04\sAM$/)
})

test('a date the card turns down stays open and says why', async ({ page }) => {
  await newNote(page, 'Dated', 'Some text.')
  await showPreview(page)
  const updated = card(page).locator('time[data-info="updated"]')
  await expect
    .poll(async () => {
      const first = await updated.textContent()
      await page.waitForTimeout(1100)
      return first === (await updated.textContent())
    })
    .toBe(true)
  await updated.click()
  const field = card(page).locator('input[data-info-edit="updated"]')
  await field.fill('2020-01-01T10:00:05')
  await page.keyboard.press('Enter')
  await expect(card(page).getByRole('alert')).toHaveText('Updated cannot be earlier than Created.')
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(field).toBeFocused()
  await field.fill('')
  await expect(card(page).getByRole('alert')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(card(page).getByRole('alert')).toHaveText('Enter a complete date and time.')
  await page.keyboard.press('Escape')
  await expect(field).toHaveCount(0)
})

test('the date button takes the keyboard back after Escape or a saved date', async ({ page }) => {
  await newNote(page, 'Back to the button', 'Some text.')
  await showPreview(page)
  const button = (key: 'created' | 'updated') =>
    card(page).getByRole('button', {
      name: new RegExp(`^${key === 'created' ? 'Created' : 'Updated'}`),
    })
  await button('created').click()
  await expect(card(page).locator('input[data-info-edit="created"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(button('created')).toBeFocused()

  await button('created').click()
  await card(page).locator('input[data-info-edit="created"]').fill('2020-01-02T03:04:05')
  await page.keyboard.press('Enter')
  await expect(card(page).locator('time[data-info="created"]')).toHaveText(
    /^Jan 2, 2020(?: at|,) 3:04\sAM$/,
  )
  await expect(button('created')).toBeFocused()
})
