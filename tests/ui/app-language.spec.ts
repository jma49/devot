import { zhHans } from '../../src/renderer/src/i18n/zh-Hans'
import { expect, test } from './fixtures'

const SIMPLIFIED_CHINESE = '\u7b80\u4f53\u4e2d\u6587'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    let chosen = 'system'
    w.devotIpcMocks = {
      app_language_set: ({ language }: { language: string }) => {
        chosen = language
        return { chosen, shown: chosen === 'system' ? 'en' : chosen, available: true }
      },
    }
  })
})

test('General picks the app language, which shows at once without a restart', async ({ page }) => {
  await page.goto('/settings.html')
  const language = page.getByLabel('App Language')
  await expect(language).toHaveValue('system')
  await expect(language.locator('option')).toHaveText([
    'Same as System',
    'English',
    SIMPLIFIED_CHINESE,
  ])

  await language.selectOption('zh-Hans')
  await expect
    .poll(() => page.evaluate(() => window.devotIpcCalls.map((c) => c.cmd)))
    .toContain('app_language_set')
  // Rust announces the language to every window, this one too.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('devot:app-language-changed', {
        detail: { chosen: 'zh-Hans', shown: 'zh-Hans', available: true },
      }),
    ),
  )
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  await expect(page.getByLabel(zhHans['generalSettings.language'])).toHaveValue('zh-Hans')
  await expect(page.getByRole('button', { name: /Restart/ })).toHaveCount(0)
})

test('a build that cannot set its own language does not offer one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      app_language_get: { chosen: 'system', shown: 'en', available: false },
    }
  })
  await page.goto('/settings.html')
  await expect(page.getByLabel('App Language')).toHaveCount(0)
})
