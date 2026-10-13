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
