import type { Page } from '@playwright/test'
import { expect, openApp, test, type TestWindow } from './fixtures'

async function openWaiting(page: Page) {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      sync_get: {
        relayUrl: 'https://relay.example.com',
        enabled: true,
        vault: true,
        enrolled: true,
        status: { state: 'stopped', lastSync: 1, code: 'E_SYNC_RESTORE_CHOICE', tooLarge: 0 },
      },
    }
  })
  await openApp(page)
  return page.getByRole('dialog', { name: 'Sync the notes restored from a backup?' })
}

test('after a restore, sync asks whether to merge or keep this Mac’s copy, Merge first', async ({
  page,
}) => {
  const dialog = await openWaiting(page)
  await expect(dialog).toContainText('Notes deleted for good on another device can’t come back')
  await expect(dialog.getByRole('button', { name: 'Merge' })).toBeFocused()
  await expect(page.getByRole('alert').filter({ hasText: 'Sync has stopped' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Keep This Mac’s Copy' }).click()
  await expect(dialog).toBeHidden()
})

test('Escape merges, as the default', async ({ page }) => {
  const dialog = await openWaiting(page)
  await expect(dialog.getByRole('button', { name: 'Merge' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
