import { expect, openApp, test } from './fixtures'

test('Rebuild Search Index from the palette shows progress, then the result', async ({ page }) => {
  await openApp(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    const w = window
    w.devotIpcMocks = {
      search_index_rebuild: () =>
        new Promise<number>((resolve) => {
          w.releaseRebuild = resolve
        }),
    }
  })
  await page.keyboard.press('Meta+KeyK')
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('rebuild search')
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(
    'Rebuild Search Index',
  )
  await page.keyboard.press('Enter')

  const notice = page.locator('[data-devot-search-index]')
  await expect(notice).toHaveText('Rebuilding search index…')
  // The app stays usable while it runs.
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()

  await page.evaluate(() => window.releaseRebuild?.(3))
  await expect(notice).toContainText('Search index rebuilt (3 notes).')
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
})

test('a failed rebuild shows its code', async ({ page }) => {
  await openApp(page)
  await expect(page.getByRole('button', { name: 'New Note', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    window.devotIpcMocks = {
      search_index_rebuild: { error: 'E_STORAGE_CORRUPT' },
    }
    const w = window
    w.dispatchEvent(new w.CustomEvent('devot:rebuild-search-index'))
  })
  await expect(page.locator('[data-devot-search-index="failed"]')).toContainText(
    'The search index could not be rebuilt.',
  )
})
