import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })
const list = (page: Page) => page.getByRole('region', { name: 'All Notes' })
const rows = (page: Page) => list(page).locator('.phone-note-row')

async function openNotes(page: Page): Promise<void> {
  await tabs(page).getByRole('button', { name: 'Notes' }).click()
  await expect(rows(page).first()).toBeVisible()
}

async function swipeRow(page: Page, index: number, by: number): Promise<void> {
  const box = (await rows(page).nth(index).boundingBox())!
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width - 20, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 20 - by, y, { steps: 14 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await expect(tabs(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`the note list shows rows, a count and the status filter, ${colorScheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme })
    await openNotes(page)
    await expect(list(page).getByRole('tablist', { name: 'Status filter' })).toBeVisible()
    await expect(list(page).getByRole('tab')).toHaveCount(4)
    await expect(list(page).getByText(/^\d+ notes$/)).toBeVisible()
    const row = (await rows(page).first().locator('.phone-note-open').boundingBox())!
    expect(row.height).toBeGreaterThanOrEqual(76)
  })
}

test('the filter keeps only notes in that status', async ({ page }) => {
  await openNotes(page)
  await list(page).getByRole('tab', { name: /Done/ }).click()
  await expect(list(page).getByRole('tab', { name: /Done/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  for (const badge of await list(page).locator('.phone-status-badge').all())
    await expect(badge).toHaveAttribute('aria-label', 'Completed')
})

test('a row swiped past half stays open with its three actions', async ({ page }) => {
  await openNotes(page)
  await swipeRow(page, 0, 130)
  const actions = rows(page).first().locator('.phone-swipe-action')
  await expect(actions).toHaveCount(3)
  await expect(actions.nth(2)).toBeInViewport()
  await expect(rows(page).first().locator('.phone-note-content')).toHaveAttribute('data-raised')
})

test('a row swiped past 280 completes its note', async ({ page }) => {
  await openNotes(page)
  const title = (await rows(page).first().locator('.phone-note-title').textContent())!
  // Past 190 the drag meets the 0.6 rubber band, so 280 needs about 340 of travel.
  await swipeRow(page, 0, 370)
  await expect(
    rows(page).filter({ hasText: title }).first().locator('.phone-status-badge'),
  ).toHaveAttribute('aria-label', 'Completed')
})

test('a long press peeks, and the status bar sets the status', async ({ page }) => {
  await openNotes(page)
  const box = (await rows(page).first().boundingBox())!
  await page.mouse.move(box.x + 100, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(600)
  await page.mouse.up()
  const peek = page.getByRole('group', { name: 'Set Status' })
  await expect(peek).toBeVisible()
  await peek.getByRole('button', { name: 'On Hold' }).click()
  await expect(peek).toHaveCount(0)
  await list(page)
    .getByRole('tab', { name: /On Hold/ })
    .click()
  await expect(rows(page)).not.toHaveCount(0)
})

test('the row actions are offered without a gesture', async ({ page }) => {
  await openNotes(page)
  await rows(page)
    .first()
    .getByRole('button', { name: /^Actions for / })
    .evaluate((el) => (el as HTMLElement).click())
  await expect(page.getByRole('menuitem', { name: 'Move to Trash' })).toBeVisible()
})

test('a note opens in Edit, switches to Preview and shows its info sheet', async ({ page }) => {
  await openNotes(page)
  await rows(page).first().locator('.phone-note-open').click()
  const toggle = page.getByRole('button', { name: 'Preview', exact: true })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: 'Note Info' }).click()
  const sheet = page.getByRole('dialog', { name: 'Note Info' })
  await expect(sheet.getByText('Words')).toBeVisible()
  await sheet.getByRole('button', { name: 'Close' }).click()
  await expect(sheet).toHaveCount(0)
})

test('capture grows from the new-note circle and saves a note to the top of the list', async ({
  page,
}) => {
  await openNotes(page)
  await page.getByRole('button', { name: 'New Note' }).click()
  const sheet = page.getByRole('dialog', { name: 'New Note' })
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Title').fill('Relay retention')
  await sheet.getByRole('button', { name: 'Save note' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(rows(page).filter({ hasText: 'Relay retention' })).toHaveCount(1)
})

test('Settings lists its sections and opens a pane', async ({ page }) => {
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('region', { name: 'Settings' })
  await expect(settings.getByRole('button', { name: /Appearance/ })).toBeVisible()
  await settings.getByRole('button', { name: /General/ }).click()
  await expect(page.locator('section.phone-screen[aria-label="General"]')).toBeVisible()
})

async function openPane(page: Page, name: string) {
  await tabs(page).getByRole('button', { name: 'Settings' }).click()
  await page
    .getByRole('region', { name: 'Settings' })
    .getByRole('button', { name, exact: true })
    .click()
  const pane = page.locator(`section.phone-screen[aria-label="${name}"]`)
  await expect(pane.locator('.settings-section')).toBeAttached()
  return pane
}

test('Appearance on a phone leaves out the Mac window style, transparency and accent', async ({
  page,
}) => {
  const pane = await openPane(page, 'Appearance')
  await expect(pane.getByText('Color scheme')).toBeVisible()
  await expect(pane.getByText('Interface style')).toHaveCount(0)
  await expect(pane.getByText('Glass Transparency')).toHaveCount(0)
  await expect(pane.getByText('Use the System Accent Color')).toHaveCount(0)
})

test('General on a phone leaves out the menu bar, updates and command line tool', async ({
  page,
}) => {
  const pane = await openPane(page, 'General')
  for (const title of ['Menu Bar', 'Updates', 'Command Line']) {
    await expect(pane.getByRole('heading', { name: title })).toHaveCount(0)
  }
})

test('a phone Settings row puts its field under its label, full width, in iPhone words', async ({
  page,
}) => {
  const pane = await openPane(page, 'AI')
  const field = pane.getByRole('textbox', { name: 'Endpoint' }).first()
  const label = pane.getByText('Endpoint', { exact: true }).first()
  const [fieldBox, labelBox, cardBox] = await Promise.all([
    field.boundingBox(),
    label.boundingBox(),
    pane.locator('.settings-card').filter({ has: field }).boundingBox(),
  ])
  expect(fieldBox!.y).toBeGreaterThanOrEqual(labelBox!.y + labelBox!.height)
  expect(fieldBox!.width).toBeGreaterThan(cardBox!.width * 0.8)
  await expect(pane.getByText(/server on this iPhone/).first()).toBeVisible()
})

test('no Settings or Library card clips its rows', async ({ page }) => {
  for (const tab of ['Settings', 'Library']) {
    await tabs(page).getByRole('button', { name: tab }).click()
    const cards = page.getByRole('region', { name: tab }).locator('.phone-card')
    await expect(cards.first()).toBeVisible()
    for (const card of await cards.all()) {
      const { client, content } = await card.evaluate((el) => ({
        client: el.clientHeight,
        content: el.scrollHeight,
      }))
      expect(content, tab).toBeLessThanOrEqual(client)
    }
  }
})

test('every enabled button on the note list is at least 44 points', async ({ page }) => {
  await openNotes(page)
  for (const button of await list(page).locator('button:visible:not([disabled])').all()) {
    if (await button.evaluate((el) => el.classList.contains('phone-visually-hidden'))) continue
    const box = await button.boundingBox()
    if (!box || box.width === 0) continue
    expect(box.height, (await button.getAttribute('aria-label')) ?? '').toBeGreaterThanOrEqual(44)
  }
})
