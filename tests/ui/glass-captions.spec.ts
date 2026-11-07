import type { Locator, Page } from '@playwright/test'
import { expect, openApp, pickNoteMore, test } from './fixtures'

test.use({ viewport: { width: 1280, height: 820 } })

async function note(page: Page, title: string, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(text)
}

const computed = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property)

const showPreview = (page: Page) =>
  page.locator('.editor-toolbar').getByRole('button', { name: 'Preview', exact: true }).click()

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('list captions share the sidebar caption style, and no rule separates sections', async ({
  page,
}) => {
  await note(page, 'First', 'Text')
  await pickNoteMore(page, 'Pin to Top')
  await note(page, 'Second', 'Text')
  const captions = page.locator('.list-section')
  await expect(captions).toHaveText(['Pinned', 'Notes'])
  const sidebarCaption = page.locator('.sidebar .section-header').first()
  for (const property of ['font-size', 'font-weight', 'color']) {
    expect(await computed(captions.first(), property), property).toBe(
      await computed(sidebarCaption, property),
    )
  }
  await expect(captions.first()).toHaveCSS('font-size', '11px')
  await expect(captions.first()).toHaveCSS('font-weight', '600')
  await expect(captions.first().locator('.icon, .icon-svg')).toBeHidden()

  const second = captions.nth(1)
  const before = await second.evaluate((el) => getComputedStyle(el, '::before').content)
  expect(['none', 'normal']).toContain(before)
  expect(await computed(second, 'border-top-width')).toBe('0px')
  expect(
    parseFloat(await computed(second, 'padding-top')) -
      parseFloat(await computed(captions.first(), 'padding-top')),
  ).toBe(14)

  const listLeft = (await page.locator('.list').boundingBox())?.x ?? 0
  const ink = await captions.first().evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.lastChild as Node)
    return range.getBoundingClientRect().left
  })
  expect(Math.round(ink - listLeft)).toBe(24)
})

test('footnotes open with a 48 pt hairline on the text edge', async ({ page }) => {
  await note(page, 'Notes', 'Text with a note.[^1]\n\n[^1]: The note.')
  await showPreview(page)
  const footnotes = page.locator('.preview .footnotes')
  await expect(footnotes).toBeVisible()
  await expect(footnotes).toHaveCSS('border-top-width', '0px')
  expect(parseFloat(await computed(footnotes, 'font-size'))).toBeCloseTo(12, 1)
  const rule = await footnotes.evaluate((el) => {
    const style = getComputedStyle(el, '::before')
    return { width: style.width, height: style.height, left: style.left }
  })
  expect(rule).toEqual({ width: '48px', height: '1px', left: '0px' })
  const offset = await page.locator('.preview').evaluate((preview) => {
    const p = preview.querySelector('p')
    const f = preview.querySelector('.footnotes')
    return Math.abs((p?.getBoundingClientRect().left ?? 0) - (f?.getBoundingClientRect().left ?? 1))
  })
  expect(offset).toBeLessThan(1)
})

test('the footnote rule stays full width in print', async ({ page }) => {
  await note(page, 'Notes', 'Text with a note.[^1]\n\n[^1]: The note.')
  await showPreview(page)
  const footnotes = page.locator('.preview .footnotes')
  await expect(footnotes).toBeVisible()
  await page.emulateMedia({ media: 'print' })
  await expect(footnotes).toHaveCSS('border-top-width', '1px')
  await page.emulateMedia({ media: 'screen' })
})
