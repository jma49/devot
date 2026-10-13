import { expect, openSettings, test, type TestWindow } from './fixtures'

// Clearing the usage data from the keyboard leaves the keyboard on the Clear
// button, which turns off (aria-disabled) instead of dropping it.
test('Clear Usage Data keeps the keyboard on its button once nothing is left', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    let current: unknown[] = [
      { id: 1, at: Date.UTC(2026, 9, 10, 9, 30), name: 'note.created', properties: {} },
    ]
    w.devotIpcMocks = {
      usage_list: () => current,
      usage_clear: () => {
        current = []
        return null
      },
    }
  })
  await openSettings(page, 'Usage')
  const section = page.getByRole('region', { name: 'Usage Data' })
  const clear = section.getByRole('button', { name: 'Clear Usage Data…' })
  await expect(clear).toBeEnabled()
  await clear.focus()
  await page.keyboard.press('Enter')
  const confirm = page.getByRole('dialog', { name: 'Clear all usage data?' })
  await confirm.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(section).toContainText('No usage events are stored.')
  await expect(clear).toBeDisabled()
  await expect(clear).toBeFocused()
  // Return on a button that is off does nothing.
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
