import type { Page } from '@playwright/test'
import { clipboardWrites, expect, test } from './fixtures'

// Fenced code blocks in the editor: each sits in a box, and while the cursor
// is in one a copy button copies its code without the fences.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const copyButton = (page: Page) => page.getByRole('button', { name: 'Copy code block' })

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('the copy button shows in the block the cursor is in and copies its code', async ({
  page,
}) => {
  await newNote(page, 'Intro\n\n```js:file.js\nconst a = 1\n\nb()\n```\n\nAfter')
  await expect(page.locator('.cm-line.cm-codeblock')).toHaveCount(5)
  await expect(page.locator('.cm-codeblock-info')).toHaveText('js:file.js')
  // The cursor is after the block: no button.
  await expect(copyButton(page)).toHaveCount(0)

  await page.locator('.cm-line', { hasText: 'const a = 1' }).click()
  await expect(copyButton(page)).toBeVisible()
  await copyButton(page).click()
  await expect.poll(() => clipboardWrites(page)).toEqual(['const a = 1\n\nb()'])
  // The click leaves the cursor in the block.
  await expect(body(page)).toBeFocused()
  await expect(copyButton(page)).toHaveAttribute('data-state', 'copied')

  await page.locator('.cm-line', { hasText: 'After' }).click()
  await expect(copyButton(page)).toHaveCount(0)
})

test('a block in a quote has a box but no copy button', async ({ page }) => {
  await newNote(page, '> ```\n> quoted\n> ```')
  await page.locator('.cm-line', { hasText: 'quoted' }).click()
  await expect(page.locator('.cm-line.cm-codeblock')).toHaveCount(3)
  await expect(copyButton(page)).toHaveCount(0)
})
