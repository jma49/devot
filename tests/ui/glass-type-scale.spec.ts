import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

const DOC = [
  'First paragraph.',
  'Second paragraph.',
  'Before the first.',
  '# One',
  'After one.',
  '## Two',
  'After two.',
  '### Three',
  'After three.',
].join('\n\n')

async function openNote(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('A title')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(DOC)
}

const showPreview = (page: Page) =>
  page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()

const gapAbove = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const above = el.previousElementSibling as Element
    return el.getBoundingClientRect().top - above.getBoundingClientRect().bottom
  })

const gapBelow = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const below = el.nextElementSibling as Element
    return below.getBoundingClientRect().top - el.getBoundingClientRect().bottom
  })

test('the Glass preview sets the note on one type scale', async ({ page }) => {
  await openNote(page)
  await showPreview(page)

  const title = page.locator('.title')
  await expect(title).toHaveCSS('font-size', '28px')
  await expect(title).toHaveCSS('line-height', '34px')
  await expect(title).toHaveCSS('font-weight', '700')
  await expect(title).toHaveCSS('letter-spacing', '-0.4px')

  const body = page.locator('.preview p').first()
  await expect(body).toHaveCSS('font-size', '14px')
  await expect(body).toHaveCSS('line-height', '22.4px')

  for (const [tag, size, line, weight] of [
    ['h1', '22px', '28px', '700'],
    ['h2', '19px', '24px', '700'],
    ['h3', '16px', '22px', '600'],
  ] as const) {
    const heading = page.locator(`.preview ${tag}`)
    await expect(heading).toHaveCSS('font-size', size)
    await expect(heading).toHaveCSS('line-height', line)
    await expect(heading).toHaveCSS('font-weight', weight)
    await expect(heading).toHaveCSS('border-bottom-width', '0px')
    await expect(heading).toHaveCSS('padding-bottom', '0px')
  }

  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(1)
  near(await gapBelow(page, '.preview p:first-child'), 12)
  near(await gapAbove(page, '.preview h2'), 26)
  near(await gapBelow(page, '.preview h2'), 8)
  near(await gapAbove(page, '.preview h3'), 20)
  near(await gapBelow(page, '.preview h3'), 6)
})

test('the pills sit 10 under the title and the body 22 under the pills', async ({ page }) => {
  await openNote(page)
  await showPreview(page)
  const title = await page.locator('.title').boundingBox()
  const meta = await page.locator('.note-meta').boundingBox()
  const first = await page.locator('.preview > :first-child').boundingBox()
  if (!title || !meta || !first) throw new Error('no layout')
  expect(Math.abs(meta.y - (title.y + title.height) - 10)).toBeLessThan(1)
  expect(Math.abs(first.y - (meta.y + meta.height) - 22)).toBeLessThan(1)
})

test('a first heading adds no space above the body', async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('## Top\n\nText.')
  await showPreview(page)
  const body = await page.locator('.preview-body').boundingBox()
  const heading = await page.locator('.preview h2').boundingBox()
  if (!body || !heading) throw new Error('no layout')
  expect(Math.abs(heading.y - body.y)).toBeLessThan(1)
})

test('the preview scale follows the preview font size setting', async ({ page }) => {
  await openNote(page)
  await showPreview(page)
  await changeEditorSettingsElsewhere(page, { previewFontSize: 30 })
  await expect(page.locator('.preview p').first()).toHaveCSS('font-size', '28px')
  await expect(page.locator('.preview h2')).toHaveCSS('font-size', '38px')
  await expect(page.locator('.preview h2')).toHaveCSS('line-height', '48px')
})

test('the editor heading lines match the scale and follow the editor font size', async ({
  page,
}) => {
  await openNote(page)
  await expect(page.locator('.cm-line.cm-md-h1')).toHaveCSS('font-size', '22px')
  await expect(page.locator('.cm-line.cm-md-h2')).toHaveCSS('font-size', '19px')
  await expect(page.locator('.cm-line.cm-md-h3')).toHaveCSS('font-size', '16px')
  await expect(page.locator('.cm-line.cm-md-h2')).toHaveCSS('line-height', '24px')
  await expect(page.locator('.cm-line.cm-md-h3')).toHaveCSS('font-weight', '600')

  await changeEditorSettingsElsewhere(page, { fontSize: 26 })
  await expect(page.locator('.cm-line.cm-md-h2')).toHaveCSS('font-size', '38px')
})
