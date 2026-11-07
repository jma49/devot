import { expect, openApp, test } from './fixtures'

test('an untitled headline shares the title line with its time', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('untitled.png') })
})
