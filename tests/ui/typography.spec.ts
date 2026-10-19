import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// Note text is set from one system (preview/content.css, `note.*` tokens):
// vertical space in quarter steps of one body line, headings on one scale,
// and the CJK properties where the web view has them.

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

const NOTE = [
  '# Top',
  '',
  'First paragraph, \u4e2d\u6587 and English.',
  '',
  'Second paragraph.',
  '',
  '## Section',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '- one',
  '- two',
  '',
  '### Third',
  '#### Fourth',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
].join('\n')

interface Box {
  top: number
  bottom: number
}

test('note text keeps one rhythm: spaces in quarter lines, headings on one scale', async ({
  page,
}) => {
  await page.goto('/')
  await newNote(page, 'Rhythm', NOTE)
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview' })
    .click()
  const body = preview(page).locator('.preview-body')
  await expect(body.locator('table')).toBeVisible()

  const measured = await body.evaluate((root) => {
    type Style = { fontSize: string; lineHeight: string }
    const css = (el: unknown) =>
      (globalThis as unknown as { getComputedStyle(e: unknown): Style }).getComputedStyle(el)
    type El = { tagName: string; getBoundingClientRect(): Box; children: ArrayLike<El> }
    const kids = Array.from((root as unknown as El).children)
    const p = kids.find((k) => k.tagName === 'P')!
    const size = (tag: string) =>
      Number.parseFloat(css(kids.find((k) => k.tagName === tag)).fontSize)
    const gaps = kids.slice(1).map((k, i) => ({
      pair: `${kids[i]!.tagName}>${k.tagName}`,
      gap: k.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom,
    }))
    return {
      font: Number.parseFloat(css(p).fontSize),
      line: Number.parseFloat(css(p).lineHeight),
      h1: size('H1'),
      h2: size('H2'),
      h3: size('H3'),
      h4: size('H4'),
      headingLine: Number.parseFloat(css(kids.find((k) => k.tagName === 'H2')).lineHeight),
      gaps,
    }
  })

  // The heading scale: the major third, h4 at the body size; headings set tighter.
  expect(measured.h1 / measured.font).toBeCloseTo(1.953, 2)
  expect(measured.h2 / measured.font).toBeCloseTo(1.563, 2)
  expect(measured.h3 / measured.font).toBeCloseTo(1.25, 2)
  expect(measured.h4).toBeCloseTo(measured.font, 1)
  expect(measured.headingLine / measured.h2).toBeLessThan(measured.line / measured.font)

  // Every gap between blocks is a whole number of quarter lines.
  const quarter = measured.line / 4
  const steps = Object.fromEntries(
    measured.gaps.map(({ pair, gap }) => [pair, Math.round((gap / quarter) * 100) / 100]),
  )
  expect(steps).toMatchObject({
    'H1>P': 2,
    'P>P': 2,
    // More space above a heading than below it.
    'P>H2': 6,
    'H2>DIV': 2,
    'DIV>UL': 3,
    'UL>H3': 5,
    'H3>H4': 3,
    'H4>TABLE': 1,
  })
})

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
    const css = (globalThis as unknown as { CSS: { supports(q: string): boolean } }).CSS
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
    // Code keeps its own spacing.
    await expect(code).toHaveCSS('text-autospace', 'no-autospace')
  }
  if (supported.trim) await expect(paragraph).toHaveCSS('text-spacing-trim', 'trim-start')
  if (supported.hanging) {
    await expect(paragraph).toHaveCSS('hanging-punctuation', 'first allow-end')
    await expect(code).toHaveCSS('hanging-punctuation', 'none')
  }
  if (supported.pretty) await expect(paragraph).toHaveCSS('text-wrap-style', 'pretty')
})
