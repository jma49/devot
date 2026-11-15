import { expect, test } from './fixtures'

const SIMPLIFIED_CHINESE = '\u7b80\u4f53\u4e2d\u6587'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    let chosen = 'system'
    w.devotIpcMocks = {
      app_language_set: ({ language }: { language: string }) => {
        chosen = language
        return { chosen, running: 'system', available: true }
      },
      app_language_restart: null,
    }
  })
})

test('General picks the app language, and offers a restart until it shows', async ({ page }) => {
  await page.goto('/settings.html')
  const language = page.getByLabel('App Language')
  await expect(language).toHaveValue('system')
  await expect(language.locator('option')).toHaveText([
    'Same as System',
    'English',
    SIMPLIFIED_CHINESE,
  ])
  const restart = page.getByRole('button', { name: 'Restart Now' })
  await expect(restart).toHaveCount(0)

  await language.selectOption('zh-Hans')
  await expect(page.getByText('Restart Devot to show the language you chose.')).toBeVisible()
  await restart.click()
  await expect
    .poll(() => page.evaluate(() => window.devotIpcCalls.map((c) => c.cmd)))
    .toContain('app_language_restart')

  await language.selectOption('system')
  await expect(restart).toHaveCount(0)
})

test('a build that cannot set its own language does not offer one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      app_language_get: { chosen: 'system', running: 'system', available: false },
    }
  })
  await page.goto('/settings.html')
  await expect(page.getByLabel('App Language')).toHaveCount(0)
})
