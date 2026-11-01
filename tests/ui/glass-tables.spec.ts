import { readFileSync } from 'node:fs'
import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

test('Glass preview tables round and scroll inside the pane; Classic and export keep the grid', async ({
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
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expect(table).toHaveCSS('border-radius', '0px')
  await expect(table).toHaveCSS('border-collapse', 'collapse')
  await page.setContent(
    '<article class="preview"><table><thead><tr><th>Export</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table></article>',
  )
  await page.addStyleTag({
    content:
      readFileSync('src/renderer/src/theme/tokens.css', 'utf8') +
      readFileSync('src/renderer/src/preview/content.css', 'utf8'),
  })
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-material')
  await expect(page.locator('table')).toHaveCSS('border-radius', '0px')
  await expect(page.locator('table')).toHaveCSS('border-collapse', 'collapse')
  await expect(page.locator('td')).toHaveCSS('border-top-width', '1px')
})
