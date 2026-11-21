import { en } from '../../src/renderer/src/i18n/en'
import { zhHans } from '../../src/renderer/src/i18n/zh-Hans'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// A language picked in Settings shows in every window at once (src/renderer/src/liveLocale.tsx):
// a page switched in place must read exactly as the same page opened in that language, which Rust
// sets before the page loads (`devotLanguage`, src-tauri/src/app_language.rs).

const LANGUAGES = { en: 'en', 'zh-Hans': 'zh-Hans' } as const
type Shown = keyof typeof LANGUAGES

/** Every text a reader meets: the page's visible text and each label, title and placeholder. */
function words(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [`title: ${document.title}`]
    const attributes = ['aria-label', 'title', 'placeholder', 'aria-description', 'alt']
    for (const element of document.querySelectorAll('*')) {
      for (const name of attributes) {
        const value = element.getAttribute(name)
        if (value) out.push(`${name}: ${value}`)
      }
    }
    out.push(...document.body.innerText.split('\n').filter((line) => line.trim() !== ''))
    return out
  })
}

async function openIn(page: Page, path: string, shown: Shown, ready: string) {
  await page.evaluate((tag) => sessionStorage.setItem('devotTestLanguage', tag), shown)
  await page.goto(path)
  await expect(page.locator('html')).toHaveAttribute('lang', LANGUAGES[shown])
  await page.locator(ready).first().waitFor()
}

async function switchTo(page: Page, shown: Shown) {
  await page.evaluate(
    (detail) => window.dispatchEvent(new CustomEvent('devot:app-language-changed', { detail })),
    { chosen: shown, shown, available: true },
  )
  await expect(page.locator('html')).toHaveAttribute('lang', LANGUAGES[shown])
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const tag = sessionStorage.getItem('devotTestLanguage')
    if (tag) Object.assign(window, { devotLanguage: tag })
  })
  await page.goto('/settings.html')
})

const PAGES = [
  { name: 'the main window', path: '/', ready: '.window[data-ready]' },
  {
    name: 'Settings > General',
    path: '/settings.html?pane=general',
    ready: '.settings-pane',
  },
  {
    name: 'Settings > Keyboard',
    path: '/settings.html?pane=keyboard',
    ready: '.settings-pane',
  },
  {
    name: 'quick capture',
    path: '/quick-capture.html',
    ready: '.quick-capture-editor',
  },
]

for (const { name, path, ready } of PAGES) {
  for (const [from, to] of [
    ['en', 'zh-Hans'],
    ['zh-Hans', 'en'],
  ] as const) {
    test(`${name} switches from ${from} to ${to} in place, as if opened in it`, async ({
      page,
    }) => {
      await openIn(page, path, to, ready)
      const opened = await words(page)
      await openIn(page, path, from, ready)
      expect(await words(page)).not.toEqual(opened)
      await switchTo(page, to)
      await expect.poll(() => words(page)).toEqual(opened)
    })
  }
}

test('an open note keeps its text, caret and preview, which switch language with the rest', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.window[data-ready]').waitFor()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Plan')
  const body = page.getByRole('textbox', { name: en['note.bodyLabel'] })
  await body.click()
  await page.keyboard.insertText('> [!note]\n> Steps')
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('devot:open-url', {
        detail: { kind: 'command', id: 'view.split' },
      }),
    ),
  )
  const alert = page.locator('.preview .alert-title')
  await expect(alert).toHaveText(en['alert.note'])

  await switchTo(page, 'zh-Hans')
  await expect(page.getByRole('textbox', { name: zhHans['note.bodyLabel'] })).toBeFocused()
  await expect(alert).toHaveText(zhHans['alert.note'])
  await page.keyboard.insertText(' done')
  await expect(page.locator('.cm-content')).toContainText('Steps done')
})
