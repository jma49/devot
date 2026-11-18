import type { Page } from '@playwright/test'
import { expect, openApp, reloadApp, test } from './fixtures'

const launcher = (page: Page) => page.getByRole('region', { name: 'Quick Actions' })
const action = (
  page: Page,
  id: 'new-note' | 'open-today' | 'command-palette' | 'new-from-template',
) => launcher(page).locator(`[data-launcher-action="${id}"]`)
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('shows the empty-pane Glass launcher with live shortcut badges and keeps list New Note unique', async ({
  page,
}) => {
  await expect(launcher(page)).toBeVisible()
  await expect(launcher(page).locator('.empty-pane-hint')).toHaveText(
    'Select a note or start from an action below.',
  )
  await expect(action(page, 'new-note')).toHaveText('New Note\u2318N')
  await expect(action(page, 'open-today')).toHaveText('Open Today\u2019s Note\u2325\u2318T')
  await expect(action(page, 'command-palette')).toHaveText('Command Palette\u2318K')
  await expect(action(page, 'new-from-template')).toHaveText('New Note from Template\u2026\u2318T')
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toHaveCount(1)
})

test('runs palette, template and new-note actions, and hides when a note, multi-selection, Trash or built-in template shows', async ({
  page,
}) => {
  await action(page, 'command-palette').click()
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  await action(page, 'new-from-template').click()
  const picker = page.getByRole('dialog', { name: 'New Note from Template' })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)

  await action(page, 'new-note').click()
  await expect(launcher(page)).toHaveCount(0)
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill('Alpha')

  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(titleField(page)).toHaveValue('')
  await titleField(page).fill('Beta')
  await expect(noteRows(page)).toHaveCount(2)

  await noteRows(page)
    .filter({ hasText: 'Alpha' })
    .click({ modifiers: ['Shift'] })
  await expect(page.getByRole('region', { name: 'Selected Notes' })).toBeVisible()
  await expect(launcher(page)).toHaveCount(0)

  await sidebar(page)
    .getByRole('button', { name: /^Trash \d+$/ })
    .click()
  await expect(launcher(page)).toHaveCount(0)

  await sidebar(page)
    .getByRole('button', { name: /^Templates \d+$/ })
    .click()
  await expect(launcher(page)).toBeVisible()
  await page
    .getByRole('group', { name: 'Built-in' })
    .getByRole('button', { name: 'Planning' })
    .click()
  await expect(page.getByRole('region', { name: 'Planning' })).toBeVisible()
  await expect(launcher(page)).toHaveCount(0)

  await page.addInitScript(() => localStorage.removeItem('devot.lastState.main'))
  await reloadApp(page)
  await expect(launcher(page)).toBeVisible()
})

test('opens today\u2019s note directly from the launcher', async ({ page }) => {
  await action(page, 'open-today').click()
  await expect(launcher(page)).toHaveCount(0)
  await expect(noteRows(page)).toHaveCount(1)
  await expect(titleField(page)).toBeVisible()
})

test('uses aria-disabled on note-creating actions when the trial has ended, while palette stays interactive', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window
    w.dispatchEvent(
      new w.CustomEvent('devot:licence-changed', {
        detail: {
          gated: true,
          state: 'none',
          code: null,
          id: null,
          licensee: null,
          plan: null,
          trial: { state: 'ended', endsAt: Date.now() - 3_600_000, code: null },
        },
      }),
    )
  })
  const newBtn = action(page, 'new-note')
  const templateBtn = action(page, 'new-from-template')
  const paletteBtn = action(page, 'command-palette')

  await expect(newBtn).toHaveAttribute('aria-disabled', 'true')
  await expect(newBtn).not.toHaveAttribute('disabled')
  await expect(templateBtn).toHaveAttribute('aria-disabled', 'true')
  await expect(templateBtn).not.toHaveAttribute('disabled')
  await expect(paletteBtn).not.toHaveAttribute('aria-disabled', 'true')

  await newBtn.evaluate((el) => (el as HTMLElement).click())
  await expect(noteRows(page)).toHaveCount(0)
  await expect(launcher(page)).toBeVisible()

  await paletteBtn.click()
  await expect(page.getByRole('dialog', { name: 'Command Palette' })).toBeVisible()
})
