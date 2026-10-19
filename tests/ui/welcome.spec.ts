import { expect, test } from './fixtures'

// A library that has never held anything opens with a Getting started
// notebook: a welcome note and a Markdown example (core/welcome.ts). The
// tests' libraries start empty unless a test asks for the notes.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
})

test('a new library starts with the welcome note and the Markdown example', async ({ page }) => {
  await expect(page.getByText('Getting started').first()).toBeVisible()
  await expect(page.getByText('Welcome to Devot').first()).toBeVisible()
  await expect(page.getByText('Markdown example').first()).toBeVisible()
})

test('the example shows a code block with its title and language mark', async ({ page }) => {
  await page.getByText('Markdown example').first().click()
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()
  const preview = page.getByRole('article', { name: 'Preview' })
  const head = preview.locator('.code-header', { hasText: 'example.ts' })
  await expect(head).toHaveCount(1)
  await expect(head.locator('svg.code-lang-icon path')).toHaveCount(1)
  await expect(preview.locator('.code-header', { hasText: 'Shell' })).toHaveCount(1)
  await expect(preview.locator('img').first()).toBeVisible()
  await expect(preview.locator('table')).toHaveCount(1)
  await expect(preview.locator('[data-devot-island="mermaid"]')).toHaveCount(1)
})
