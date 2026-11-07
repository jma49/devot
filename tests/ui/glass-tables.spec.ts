import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

test('preview tables round and scroll inside the pane; export keeps the grid', async ({
  page,
}, testInfo) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  const columns = Array.from({ length: 40 }, (_, i) => `Column ${i}`)
  await page.keyboard.insertText(
    `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.join(' | ')} |` +
      '\n\n```js\nconst value = 1\n```\n\n> [!NOTE]\n> A note',
  )

  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Preview', exact: true })
    .click()
  const table = page.locator('.preview table')
  await expect(table).toHaveCSS('border-radius', '12px')
  await expect(table).toHaveCSS('border-collapse', 'separate')
  await expect(page.locator('.preview .code-block')).toHaveCSS('border-radius', '12px')
  await expect(page.locator('.preview .alert')).toHaveCSS('border-radius', '12px')
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.locator('.preview').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  )
  await page.screenshot({ path: testInfo.outputPath('glass-table.png') })
  await page.setContent(
    '<article class="preview"><table><thead><tr><th>Export</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table></article>',
  )
  await page.addStyleTag({
    content:
      readFileSync('src/renderer/src/theme/tokens.css', 'utf8') +
      readFileSync('src/renderer/src/preview/content.css', 'utf8'),
  })
  await expect(page.locator('table')).toHaveCSS('border-radius', '0px')
  await expect(page.locator('table')).toHaveCSS('border-collapse', 'collapse')
  await expect(page.locator('td')).toHaveCSS('border-top-width', '1px')
})

// A cell's word on more than one line box means the column broke it.
const brokenWords = (page: Page, table: string) =>
  page.locator(table).evaluate((el) =>
    Array.from(el.querySelectorAll('th, td')).flatMap((cell) => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      const lines = new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top)))
      return lines.size > 1 ? [cell.textContent] : []
    }),
  )

const WIDE = (() => {
  const head = Array.from({ length: 30 }, (_, i) => `Quarterly${i}`)
  const row = Array.from({ length: 30 }, (_, i) => `Forecast${i}`)
  return [head, head.map(() => '---'), row, row].map((cells) => `| ${cells.join(' | ')} |`)
})()

test('a 30-column table keeps its words whole and scrolls sideways in its own box, in the preview and an export', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 })
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(WIDE.join('\n'))
  await page
    .getByRole('group', { name: 'View mode' })
    .getByRole('button', { name: 'Split', exact: true })
    .click()

  const table = page.locator('.preview table')
  await expect(table.locator('th')).toHaveCount(30)
  expect(await brokenWords(page, '.preview table')).toEqual([])
  const narrowest = await table.evaluate((el) =>
    Math.min(...Array.from(el.querySelectorAll('th'), (th) => th.getBoundingClientRect().width)),
  )
  expect(narrowest).toBeGreaterThan(60)
  expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.locator('.preview').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  )

  const cells = (row: string[]) => row.map((cell) => `<td>${cell}</td>`).join('')
  const [head, , first] = WIDE.map((line) => line.slice(2, -2).split(' | '))
  await page.setContent(
    `<article class="preview"><table><thead><tr>${head!.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>` +
      `<tbody><tr>${cells(first!)}</tr></tbody></table></article>`,
  )
  await page.addStyleTag({
    content: ['theme/tokens.css', 'preview/content.css', 'preview/page.css']
      .map((file) => readFileSync(`src/renderer/src/${file}`, 'utf8'))
      .join('\n'),
  })
  expect(await brokenWords(page, 'table')).toEqual([])
  expect(await page.locator('table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})
