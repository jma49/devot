import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

// Settings > Preview > Load Images from the Web, off: nothing is asked of a site until Load.

const ADDRESS = 'https://pixel.example/p.png'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

async function serve(page: Page) {
  const requests: (string | undefined)[] = []
  await page.route('https://pixel.example/**', (route) => {
    requests.push(route.request().headers()['referer'])
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  return requests
}

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

const preview = (page: Page) => page.getByRole('article', { name: 'Preview' })

test('with the setting off, an image from the web is fetched only after Load', async ({ page }) => {
  const requests = await serve(page)
  await openApp(page)
  await changeEditorSettingsElsewhere(page, { loadRemoteImages: false })
  await newNote(page, `![Pixel](${ADDRESS})\n\nafter`)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split' })
    .click()

  const waiting = preview(page).locator('.image-placeholder')
  await expect(waiting).toContainText('Image from pixel.example')
  const under = page.locator('.cm-inline-images .cm-remote-image')
  await expect(under).toContainText('Image from pixel.example')
  await expect(preview(page).locator('img')).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(requests).toEqual([])

  await waiting.getByRole('button', { name: 'Load' }).click()
  const shown = preview(page).locator(`img[src="${ADDRESS}"]`)
  await expect(shown).toBeVisible()
  await expect(page.locator('.cm-inline-images img')).toHaveAttribute('src', ADDRESS)
  await expect(under).toHaveCount(0)
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.every((referer) => referer === undefined)).toBe(true)
})

test('images from the web load by themselves by default, sending no referrer', async ({ page }) => {
  const requests = await serve(page)
  await openApp(page)
  await newNote(page, `![Pixel](${ADDRESS})`)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  await expect(preview(page).locator(`img[src="${ADDRESS}"]`)).toBeVisible()
  await expect.poll(() => requests.length).toBeGreaterThan(0)
  expect(requests.every((referer) => referer === undefined)).toBe(true)
  await expect(preview(page).locator('.image-placeholder')).toHaveCount(0)
})

test.describe('in Write mode', () => {
  test.use({ install: 'new' })

  test('an image block from the web waits for Load, then draws', async ({ page }) => {
    const requests = await serve(page)
    await openApp(page)
    await changeEditorSettingsElsewhere(page, { loadRemoteImages: false })
    await newNote(page, `Top\n![Pixel](${ADDRESS})\nEnd`)
    const block = page.locator('.cm-wm-block-image')
    await expect(block.locator('.image-placeholder')).toContainText('Image from pixel.example')
    await expect(block.locator('img')).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(requests).toEqual([])

    await block.getByRole('button', { name: 'Load' }).click()
    await expect(block.locator(`img[src="${ADDRESS}"]`)).toBeVisible()
    expect(requests.length).toBeGreaterThan(0)
  })
})
