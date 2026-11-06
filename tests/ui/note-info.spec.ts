import type { Page } from '@playwright/test'
import { expect, test, openApp } from './fixtures'

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

const summary = (page: Page) => page.getByRole('button', { name: /^Note info: / })
const card = (page: Page) => page.getByRole('dialog', { name: 'Note info' })
const picker = (page: Page) => page.getByRole('dialog', { name: /^Choose the .* date$/ })
const dateRow = (page: Page, field: 'Created' | 'Updated') =>
  card(page).getByRole('button', { name: new RegExp(`^${field}: `) })

// The typed body saves a moment later and moves the update date: wait until it has held.
async function settled(page: Page) {
  const updated = card(page).locator('time[data-info="updated"]')
  await expect
    .poll(async () => {
      const first = await updated.textContent()
      await page.waitForTimeout(1100)
      return first === (await updated.textContent())
    })
    .toBe(true)
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('the summary ends the pill row and counts the note', async ({ page }) => {
  await newNote(page, 'Chores', '- [x] dishes\n- [ ] laundry\n')
  await expect(summary(page)).toHaveText('1/2 · 2 words')
  const meta = page.locator('.note-meta')
  await expect(meta.locator('.note-summary')).toBeVisible()
  const add = (await meta.getByRole('button', { name: /Tag/ }).last().boundingBox())!
  const box = (await summary(page).boundingBox())!
  expect(box.x).toBeGreaterThan(add.x)
})

test('a note with nothing to count says when it was updated', async ({ page }) => {
  await newNote(page, 'Plain', 'Just words.')
  await expect(summary(page)).toHaveText(/^Updated .* · 2 words$/)
})

test('the summary and View > Note Info open the card, and the keyboard comes back', async ({
  page,
}) => {
  await newNote(page, 'Dated', 'Some text.')
  await summary(page).click()
  await expect(card(page)).toBeFocused()
  await expect(summary(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(card(page).locator('time')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  await expect(summary(page)).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Alt+KeyI')
  await expect(card(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Alt+KeyI')
  await expect(card(page)).toHaveCount(0)

  await summary(page).click()
  await page.getByRole('textbox', { name: 'Title' }).click()
  await expect(card(page)).toHaveCount(0)
})

test('a date is set from the date picker: Return sets, Escape cancels', async ({ page }) => {
  await newNote(page, 'Dated', 'Some text.')
  await summary(page).click()
  await settled(page)
  const created = card(page).locator('time[data-info="created"]')
  const updated = card(page).locator('time[data-info="updated"]')
  const updatedBefore = await updated.textContent()
  const createdBefore = await created.textContent()

  await dateRow(page, 'Created').click()
  await expect(picker(page)).toBeVisible()
  const today = picker(page).locator('[role="gridcell"][tabindex="0"]')
  await expect(today).toBeFocused()
  await page.keyboard.press('PageUp')
  await page.keyboard.press('Enter')
  await expect(picker(page)).toHaveCount(0)
  await expect(created).not.toHaveText(createdBefore ?? '')
  await expect(updated).toHaveText(updatedBefore ?? '')
  await expect(dateRow(page, 'Created')).toBeFocused()

  const createdNow = await created.textContent()
  await dateRow(page, 'Updated').click()
  await page.keyboard.press('PageUp')
  await page.keyboard.press('PageUp')
  await expect(picker(page).getByRole('button', { name: 'Set' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(picker(page).getByRole('alert')).toHaveText(
    'Updated cannot be earlier than Created.',
  )
  await page.keyboard.press('Escape')
  await expect(picker(page)).toHaveCount(0)
  await expect(card(page)).toBeVisible()
  await expect(updated).toHaveText(updatedBefore ?? '')
  await expect(created).toHaveText(createdNow ?? '')
})

test('the card lists the backlinks and opens one', async ({ page }) => {
  await newNote(page, 'Target', 'The linked note')
  await newNote(page, 'Source', 'Links to ')
  await page.keyboard.type('[[Targ')
  await page
    .locator('.cm-tooltip-autocomplete li')
    .filter({ hasText: /^Target/ })
    .first()
    .click()
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  // The link is stored when the source saves, so the target may need opening again.
  await expect(async () => {
    await rows.first().click()
    await rows.last().click()
    await expect(summary(page)).toHaveText(/1 backlink/, { timeout: 1000 })
  }).toPass()
  await summary(page).click()
  const link = card(page).getByRole('button', { name: 'Source' })
  await expect(link).toBeVisible()
  await link.click()
  await expect(card(page)).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Source')
})

test('the card keeps its keylines', async ({ page }) => {
  await newNote(page, 'Lines', 'Some text.')
  await summary(page).click()
  const box = (await card(page).boundingBox())!
  const left = async (selector: string) =>
    (await card(page).locator(selector).first().boundingBox())!.x - box.x
  expect(Math.abs((await left('.note-info-row')) - 6)).toBeLessThanOrEqual(1)
  expect(Math.abs((await left('.note-info-icon')) - 16)).toBeLessThanOrEqual(1)
  expect(Math.abs((await left('.note-info-label')) - 42)).toBeLessThanOrEqual(1)
  expect(Math.abs((await left('.note-info-value')) - 116)).toBeLessThanOrEqual(1)
})
