import { expect, test } from './fixtures'

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })
    test(`probe ${scheme}`, async ({ page }) => {
      await page.addInitScript(() => {
        const w = globalThis as unknown as {
          devotSeedWelcome?: boolean
          devotIpcMocks?: Record<string, unknown>
        }
        w.devotSeedWelcome = true
        ;(w as unknown as Record<string, unknown>)['devotEditorRevision'] = 2
        ;(w as unknown as Record<string, unknown>)['devotEditorSettings'] = { iconStyle: 'lucide' }
        w.devotIpcMocks = {
          backups_list: {
            backups: [{ id: 'b1', createdAt: Date.now(), size: 1 }],
            lastError: null,
          },
          mirror_get: {
            revision: 1,
            generation: 1,
            folder: '/Users/me/Notes',
            includeAttachments: true,
            paused: null,
            size: 10,
            kept: [],
            keptCount: 0,
          },
        }
      })
      await page.goto('/')
      await page.locator('.window[data-ready]').waitFor()
      await page.getByRole('treeitem', { name: /Getting started/ }).click()
      await page.getByRole('option', { name: /Welcome to Devot/ }).click()
      await page
        .getByRole('group', { name: 'View mode' })
        .getByRole('button', { name: 'Preview' })
        .click()
      await expect(page.locator('html')).toHaveAttribute('data-sidebar-material', 'on')
      await page.mouse.move(640, 810)
      await page.waitForTimeout(600)
      await page.screenshot({ path: `/tmp/lg-design/probe-${scheme}.png` })
    })
  })
}
