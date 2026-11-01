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
}, testInfo) => {
  const stats = page.getByRole('group', { name: 'Usage overview' })
  await expect(stats.locator('.usage-stat strong').first()).toHaveText('3')
  await expect(page.locator('.usage-cell')).toHaveCount(168)
  await expect(page.locator('.usage-daily title').first()).toContainText('0 events')
  await expect(page.locator('.usage-daily rect')).toHaveCount(30)
  await page.getByRole('button', { name: '7 Days', exact: true }).click()
  await expect(stats.locator('.usage-stat strong').first()).toHaveText('2')
  await expect(page.locator('.usage-daily rect')).toHaveCount(7)
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('search.run')
  await expect(stats.locator('.usage-stat strong').first()).toHaveText('1')
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('future.event')
  await expect(stats.locator('.usage-stat strong').first()).toHaveText('0')
  await page.getByRole('button', { name: '90 Days', exact: true }).click()
  await expect(stats.locator('.usage-stat strong').first()).toHaveText('1')
  await expect(page.getByRole('table', { name: 'Events by Type' })).toContainText('future.event')
  await page.getByRole('combobox', { name: 'Event type' }).selectOption('')
  await page.getByRole('button', { name: '30 Days', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 1320 })
  await page.screenshot({ path: testInfo.outputPath('usage-after.png'), fullPage: true })
  await changeEditorSettingsElsewhere(page, { appearance: 'dark' })
  await page.screenshot({ path: testInfo.outputPath('usage-dark.png'), fullPage: true })
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
  await expect(page.locator('.usage-events li')).toHaveCount(4)
  await page.getByRole('button', { name: 'Clear Usage Data\u2026' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Event type' })).toHaveValue('')
  await expect(page.getByRole('table', { name: 'Events by Type' })).not.toContainText(
    'future.event',
  )
  await expect(page.locator('.usage-stat strong').first()).toHaveText('0')
  await expect(page.locator('.usage-events')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Show Events', exact: true })).toBeDisabled()
  await expect(page.getByRole('progressbar', { name: 'Stored on this Mac' })).toHaveAttribute(
    'value',
    '0',
  )
})

test('Classic keeps the original Usage page', async ({ page }) => {
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expect(page.locator('.usage-dashboard')).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Events by Type' })).toContainText('future.event')
})
