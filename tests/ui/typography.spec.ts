import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function newNote(page: Page, title: string, body: string) {
  const before = await page.getByRole('listbox', { name: 'Notes' }).getByRole('option').count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveCount(
    before + 1,
  )
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
}

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

test('CJK text gets the line breaking and spacing the web view supports', async ({ page }) => {
  await page.goto('/')
  await newNote(page, 'CJK', '\u4e2d\u6587English\u6587\u5b571\n\n`\u4e2dcode`')
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview' })
    .click()
  const paragraph = preview(page).locator('.preview-body > p').first()
  await expect(paragraph).toBeVisible()
  await expect(paragraph).toHaveCSS('line-break', 'strict')
  await expect(paragraph).toHaveCSS('font-kerning', 'normal')

  const supported = await page.evaluate(() => {
    const css = window.CSS
    return {
      autospace: css.supports('text-autospace: normal'),
      trim: css.supports('text-spacing-trim: trim-start'),
      hanging: css.supports('hanging-punctuation: first allow-end'),
      balance: css.supports('text-wrap: balance'),
      pretty: css.supports('text-wrap: pretty'),
    }
  })
  const code = preview(page).locator('.preview-body code').first()
  if (supported.autospace) {
    await expect(paragraph).toHaveCSS('text-autospace', 'normal')
    await expect(code).toHaveCSS('text-autospace', 'no-autospace')
  }
  if (supported.trim) await expect(paragraph).toHaveCSS('text-spacing-trim', 'trim-start')
  if (supported.hanging) {
    await expect(paragraph).toHaveCSS('hanging-punctuation', 'first allow-end')
    await expect(code).toHaveCSS('hanging-punctuation', 'none')
  }
  if (supported.pretty) await expect(paragraph).toHaveCSS('text-wrap-style', 'pretty')
})
