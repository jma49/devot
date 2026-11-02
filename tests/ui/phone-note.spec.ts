import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const note = (page: Page) => page.locator('section.phone-screen:has(.phone-note-scroll)')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Tabs' })
    .getByRole('button', { name: 'Notes' })
    .click()
  await page.locator('[data-section="recent"] .phone-note-open').first().click()
  await expect(note(page).locator('.cm-content')).toBeAttached()
})

test('the top bar has back, a mono crumb and a capsule; the title is 26 bold', async ({ page }) => {
  const heading = note(page).locator('.phone-note-heading')
  await expect(heading).toHaveCSS('font-weight', '700')
  await expect(note(page).locator('.phone-note-caption')).toHaveClass(/phone-figures/)
  await expect(note(page).getByRole('button', { name: 'Back', exact: true })).toBeVisible()
  await expect(note(page).locator('.phone-note-crumb')).toHaveCSS(
    'font-family',
    /mono|Menlo|Courier/i,
  )
})

test('the mode toggle swaps Edit and Preview, and the sparkle leaves in Preview', async ({
  page,
}) => {
  const toEdit = note(page).getByRole('button', { name: 'Edit', exact: true })
  const toPreview = note(page).getByRole('button', { name: 'Preview', exact: true })
  const ai = note(page).getByRole('button', { name: 'Suggest with AI' })
  await expect(ai).toBeVisible()
  await toPreview.click()
  await expect(toEdit).toBeVisible()
  await expect(ai).toHaveCount(0)
  await expect(note(page).locator('.phone-note-preview')).toHaveAttribute('data-shown', 'true')
  await toEdit.click()
  await expect(note(page).locator('.phone-note-preview')).not.toHaveAttribute('data-shown', 'true')
})

test('bottom controls reach 44 points', async ({ page }) => {
  for (const name of ['Find in Note', 'Suggest with AI', 'Previous Note', 'Next Note']) {
    const box = (await note(page).getByRole('button', { name }).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
  }
})

test('find uses the editor: it counts matches, steps and closes', async ({ page }) => {
  await note(page).getByRole('button', { name: 'Find in Note' }).click()
  const field = note(page).getByRole('searchbox', { name: 'Find in Note' })
  await expect(note(page).locator('.phone-note-bottom')).toHaveAttribute('data-hidden', 'true')
  await field.fill('e')
  await expect(note(page).locator('.phone-find-count')).toHaveText(/^\d+ of \d+$/)
  await expect(note(page).locator('.cm-find-match').first()).toBeAttached()
  await note(page).getByRole('button', { name: 'Next match' }).click()
  await note(page).getByRole('button', { name: 'Close find' }).click()
  await expect(field).toHaveCount(0)
  await expect(note(page).locator('.cm-find-match')).toHaveCount(0)
  await expect(note(page).locator('.phone-note-bottom')).not.toHaveAttribute('data-hidden', 'true')
})

test('typing shows the formatting bar on the keyboard and hides the bottom bar', async ({
  page,
}) => {
  await page.evaluate(() => {
    const viewport = window.visualViewport!
    Object.defineProperty(viewport, 'height', { value: window.innerHeight - 300 })
    viewport.dispatchEvent(new Event('resize'))
  })
  await expect(note(page).locator('.phone-note-bottom')).toHaveAttribute('data-hidden', 'true')
  const bar = note(page).getByRole('toolbar', { name: 'Formatting' })
  await expect(note(page).locator('.phone-accessory')).toHaveAttribute('data-shown', 'true')
  await expect(bar.getByRole('button')).toHaveCount(7)
  await expect(note(page).getByRole('button', { name: 'Hide keyboard' })).toBeVisible()
})

test('note info has stats in mono, icon rows and a working Move to Trash', async ({ page }) => {
  await note(page).getByRole('button', { name: 'Note Info' }).click()
  const sheet = page.getByRole('dialog', { name: 'Note Info' })
  await expect(sheet.locator('.phone-info-stat dd').first()).toHaveClass(/phone-figures/)
  for (const row of ['Notebook', 'Created', 'Modified']) {
    await expect(
      sheet.locator('.phone-grouped-row').filter({ hasText: row }).locator('.phone-row-icon'),
    ).toBeVisible()
  }
  await expect(sheet.getByText('Revision history')).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Move to Trash' }).click()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
})
