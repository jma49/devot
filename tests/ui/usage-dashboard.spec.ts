import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  test,
  type TestWindow,
} from './fixtures'

const AT = new Date(2026, 10, 1, 12).getTime()
const events = [
  { id: 4, at: AT, name: 'note.created', properties: { from: 'new_note' } },
  {
    id: 3,
    at: AT - 86400000,
    name: 'search.run',
    properties: { scope: 'all', clauses: 1, results: '0' },
  },
  {
    id: 2,
    at: AT - 10 * 86400000,
    name: 'search.run',
    properties: { scope: 'all', clauses: 1, results: '1' },
  },
  { id: 1, at: AT - 40 * 86400000, name: 'future.event', properties: {} },
  // From another Devot version, with a name longer than the pane is wide.
  { id: 0, at: AT - 41 * 86400000, name: `future.${'long'.repeat(60)}`, properties: {} },
]

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(AT)
  await page.addInitScript((storedEvents) => {
    let stored = storedEvents
    ;(globalThis as unknown as TestWindow).devotIpcMocks = {
      usage_list: () => stored,
      usage_clear: () => {
        stored = []
        return null
      },
    }
  }, events)
  await openSettings(page, 'Usage')
})

test('filters real activity by local day and event type, including unknown types', async ({
  page,
}) => {
  const stats = page.getByRole('region', { name: 'Usage overview' })
  await expect(stats.locator('.usage-stat-value').first()).toHaveText('3')
  await expect(page.locator('.usage-cell')).toHaveCount(168)
  await expect(page.locator('.usage-daily title').first()).toContainText('0 events')
  await expect(page.locator('.usage-daily rect')).toHaveCount(30)
  await page.getByRole('button', { name: '7 Days', exact: true }).click()
  await expect(stats.locator('.usage-stat-value').first()).toHaveText('2')
  await expect(page.locator('.usage-daily rect')).toHaveCount(7)
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('search.run')
  await expect(stats.locator('.usage-stat-value').first()).toHaveText('1')
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('future.event')
  await expect(stats.locator('.usage-stat-value').first()).toHaveText('0')
  await page.getByRole('button', { name: '90 Days', exact: true }).click()
  await expect(stats.locator('.usage-stat-value').first()).toHaveText('1')
  await expect(page.getByRole('table', { name: 'Events by Type' })).toContainText('future.event')
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('')
  await page.getByRole('button', { name: '30 Days', exact: true }).click()
  await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
  await page.setViewportSize({ width: 900, height: 680 })
  expect(
    await page.locator('.usage-dashboard').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)
})

test('clearing removes the chart data and list and keeps the empty dashboard usable', async ({
  page,
}) => {
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('future.event')
  await page.getByRole('button', { name: 'Show Events', exact: true }).click()
  await expect(page.locator('.usage-events li')).toHaveCount(5)
  // From the keyboard: the button turns off (aria-disabled) and keeps the keyboard.
  const clear = page.getByRole('button', { name: 'Clear Usage Data\u2026' })
  await clear.focus()
  await page.keyboard.press('Enter')
  await page
    .getByRole('dialog', { name: 'Clear all usage data?' })
    .getByRole('button', { name: 'Clear', exact: true })
    .click()
  await expect(page.locator('.usage-storage')).toContainText('No usage events are stored.')
  await expect(clear).toBeDisabled()
  await expect(clear).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Event type' })).toHaveValue('')
  await expect(page.getByRole('table', { name: 'Events by Type' })).not.toContainText(
    'future.event',
  )
  await expect(page.locator('.usage-stat-value').first()).toHaveText('0')
  await expect(page.locator('.usage-events')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show Events', exact: true })).toBeDisabled()
  await expect(page.getByRole('progressbar', { name: 'Stored on this Mac' })).toHaveAttribute(
    'value',
    '0',
  )
})

test('Usage uses the Settings kit: the pop-up, the push buttons and rows in cards', async ({
  page,
}) => {
  const look = (el: Element) => {
    const style = getComputedStyle(el)
    return {
      background: style.backgroundColor,
      shadow: style.boxShadow,
      height: style.height,
      radius: style.borderRadius,
    }
  }
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  const kitButton = await page
    .getByRole('button', { name: 'Open Data Folder', exact: true })
    .evaluate(look)
  await page.getByRole('tab', { name: 'Usage', exact: true }).click()

  const filter = page.getByRole('combobox', { name: 'Event type' })
  await expect(filter.locator('xpath=..')).toHaveClass('select')
  await expect(filter.locator('xpath=..').locator('.select-chevron')).toHaveCount(1)

  for (const name of ['Show Events', 'Clear Usage Data…']) {
    expect(await page.getByRole('button', { name, exact: true }).evaluate(look)).toEqual(kitButton)
  }

  const overview = page.getByRole('region', { name: 'Usage overview' })
  await expect(overview.locator('.settings-card > .setting .setting-label')).toHaveText([
    'Events',
    'Active days',
    'Notes created',
  ])
  await expect(overview.locator('.usage-stat-value')).toHaveText(['3', '3 of 30', '1'])
  const storage = page.getByRole('region', { name: 'Stored on this Mac' })
  await expect(storage.locator('.settings-card')).toHaveCount(1)
  await expect(storage.locator('.settings-footnote')).toHaveCount(1)

  // The range control is the app's segmented control, not a raised glass capsule.
  await expect(page.getByRole('group', { name: 'Time period' })).toHaveCSS('box-shadow', 'none')
})
