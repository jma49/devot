import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The sidebar's folds: a notebook folded shut stays shut after a reload, and a
// notebook dragged over a row draws its line across the row's full width.

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const nameField = (page: Page) => page.getByRole('textbox', { name: 'Notebook name' })

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  await expect(nameField(page)).toHaveValue('New Notebook')
  await nameField(page).fill(name)
  await nameField(page).press('Enter')
  await expect(book(page, name)).toBeVisible()
}

const box = async (target: Locator) => {
  const found = await target.boundingBox()
  if (!found) throw new Error('E_TEST_NO_BOX')
  return found
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('a folded notebook stays folded after a reload', async ({ page }) => {
  await createBook(page, 'Parent')
  await createBook(page, 'Child')
  await row(page, 'Child').dragTo(row(page, 'Parent'))
  await expect(book(page, 'Parent')).toHaveAttribute('aria-expanded', 'true')

  await book(page, 'Parent').locator('> .book-row .disclosure').click()
  await expect(book(page, 'Parent')).toHaveAttribute('aria-expanded', 'false')
  await expect(book(page, 'Child')).toHaveCount(0)

  await page.reload()
  await expect(book(page, 'Parent')).toHaveAttribute('aria-expanded', 'false')
  await expect(book(page, 'Child')).toHaveCount(0)

  await book(page, 'Parent').locator('> .book-row .disclosure').click()
  await expect(book(page, 'Child')).toBeVisible()
  await page.reload()
  await expect(book(page, 'Child')).toBeVisible()
})

test('the line for a notebook dropped before a row spans the row', async ({ page }) => {
  await createBook(page, 'Alpha')
  await createBook(page, 'Bravo')
  const from = await box(row(page, 'Bravo'))
  const to = await box(row(page, 'Alpha'))
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 4 })
  const target = row(page, 'Alpha')
  await expect(target).toHaveClass(/drop-before/)
  const line = await target.evaluate((el) => {
    const g = globalThis as unknown as {
      getComputedStyle(e: unknown, p: string): { left: string; right: string; borderRadius: string }
    }
    const style = g.getComputedStyle(el, '::before')
    return { left: style.left, right: style.right, radius: style.borderRadius }
  })
  expect(line).toEqual({ left: '0px', right: '0px', radius: '0px' })
  await page.mouse.up()
})
