import { changeEditorSettingsElsewhere, expect, openApp, test } from './fixtures'

test('an untitled headline shares the Glass title line with its time and keeps Classic spacing', async ({
  page,
}, testInfo) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText('Shopping list\n\nMilk and bread')
  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()
  await expect(row.locator('.row-title')).toHaveText('Shopping list')
  await expect(row.locator('.row-excerpt')).not.toContainText('Shopping list')
  const title = await row.locator('.row-title').boundingBox()
  const time = await row.locator('time').boundingBox()
  expect(Math.abs(title!.y - time!.y)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: testInfo.outputPath('untitled-glass.png') })
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
  await expect(row).toHaveCSS('display', 'grid')
  const classicTitle = await row.locator('.row-title').boundingBox()
  const excerpt = await row.locator('.row-excerpt').boundingBox()
  expect(Math.abs(classicTitle!.y - excerpt!.y)).toBeLessThanOrEqual(2)
  await page.screenshot({ path: testInfo.outputPath('untitled-classic.png') })
})
