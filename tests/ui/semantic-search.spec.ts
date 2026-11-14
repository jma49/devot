import type { Page } from '@playwright/test'
import { expect, test, openApp } from './fixtures'

const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' })
const related = (page: Page) => page.locator('.list-section[data-section="section:related"]')
const count = (page: Page) => page.locator('.list .list-count')

async function createNote(page: Page, title: string, body: string) {
  const before = await noteRows(page).count()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(before + 1)
  await page.getByRole('textbox', { name: 'Title' }).fill(title)
  await page.getByRole('textbox', { name: 'Note body' }).click()
  await page.keyboard.insertText(body)
}

test.describe('with a sentence model', () => {
  test.beforeEach(async ({ page }) => {
    // The memory store's stand-in for a model: "car" means "automobile" too.
    await page.addInitScript(() =>
      localStorage.setItem('devot.test.meanings', JSON.stringify({ car: ['automobile'] })),
    )
    await openApp(page)
  })

  test('notes related by meaning follow the search results in their own section', async ({
    page,
  }) => {
    await createNote(page, 'Car service', 'Oil change in May')
    await createNote(page, 'Garage', 'The automobile needs new tyres')
    await createNote(page, 'Groceries', 'apples')

    await search(page).fill('car')
    await expect(related(page)).toHaveText('Related by Meaning')
    await expect(noteRows(page)).toHaveText([/^Car service/, /^Garage/])
    await expect(count(page)).toHaveText(/\b1 note\b/i)

    await noteRows(page).nth(1).click()
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Garage')

    await search(page).fill('apples')
    await expect(noteRows(page)).toHaveText([/^Groceries/])
    await expect(related(page)).toHaveCount(0)
  })

  test('a related note shows even when no note has the word', async ({ page }) => {
    await createNote(page, 'Garage', 'The automobile needs new tyres')
    await search(page).fill('car')
    await expect(related(page)).toBeVisible()
    await expect(noteRows(page)).toHaveText([/^Garage/])
    await expect(page.locator('.list-empty')).toHaveCount(0)
  })
})

test('without a model a search shows its own results alone', async ({ page }) => {
  await openApp(page)
  await createNote(page, 'Car service', 'Oil change')
  await createNote(page, 'Garage', 'The automobile needs new tyres')
  await search(page).fill('car')
  await expect(noteRows(page)).toHaveText([/^Car service/])
  await expect(related(page)).toHaveCount(0)
})
