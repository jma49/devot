import { expect, test, openApp } from './fixtures'

test.beforeEach(async ({ page }) => {
  await openApp(page)
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Outside notebook match')
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const name = page.getByRole('textbox', { name: 'Notebook name' })
  await name.fill('Work')
  await name.press('Enter')
  await expect(page.locator('.list .headline')).toHaveText('Work')
})

test('empty scoped search offers all notes, while an empty all-notes search only suggests other words', async ({
  page,
}, testInfo) => {
  const search = page.getByRole('searchbox', { name: 'Search notes' })
  const empty = page.locator('.list-empty')
  const searchAll = empty.getByRole('button', { name: 'Search All Notes', exact: true })
  await search.fill('no matching notes anywhere')
  await expect(empty).toContainText('No Matching Notes')
  await expect(searchAll).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('scoped-empty.png') })

  await searchAll.click()
  await expect(search).toHaveValue('no matching notes anywhere')
  await expect(search).toHaveAttribute('placeholder', 'Search All Notes')
  await expect(searchAll).toHaveCount(0)
  await expect(empty.locator('.list-empty-tip')).toHaveText('Try other words.')
  await expect(empty).not.toContainText(/search all notes/i)
  await page.screenshot({ path: testInfo.outputPath('all-empty.png') })
})

test('widening an empty notebook search keeps its query and finds notes outside the notebook', async ({
  page,
}) => {
  const search = page.getByRole('searchbox', { name: 'Search notes' })
  await search.fill('Outside notebook match')
  await page.locator('.list-empty').getByRole('button', { name: 'Search All Notes' }).click()
  await expect(search).toHaveValue('Outside notebook match')
  await expect(search).toHaveAttribute('placeholder', 'Search All Notes')
  await expect(page.getByRole('listbox', { name: 'Notes' }).getByRole('option')).toHaveText([
    /^Outside notebook match/,
  ])
  await expect(page.locator('.list-empty')).toHaveCount(0)
})
