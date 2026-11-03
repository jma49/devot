// Open Today's Note (issue #478): from the palette, its key and devot://today it opens one note a
// day, made in the daily notebook when missing, and a workspace the notebook is outside is left.
import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, pickMenuItem, reloadApp, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Sidebar' })
const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const row = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    .locator('> .book-row')
const anyWorkspace = (page: Page) => sidebar(page).locator('.sidebar-workspace')
const titleField = (page: Page) => page.getByRole('textbox', { name: 'Title' })
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const paletteField = (page: Page) =>
  palette(page).getByRole('combobox', { name: 'Command Palette' })

async function createBook(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await field.fill(name)
  await field.press('Enter')
  await expect(row(page, name)).toBeVisible()
  return page.evaluate(
    (wanted) =>
      (
        JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as {
          id: string
          name: string
        }[]
      ).find((b) => b.name === wanted)?.id ?? '',
    name,
  )
}

const stored = (page: Page, title: string) =>
  page.evaluate(
    (wanted) =>
      (
        JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
          title: string
          bookId: string | null
        }[]
      ).filter((n) => n.title === wanted),
    title,
  )

const todayIso = (page: Page) =>
  page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await reloadApp(page)
})

test('opens one note a day in the daily notebook, leaving a workspace it is outside', async ({
  page,
}) => {
  const journal = await createBook(page, 'Journal')
  await createBook(page, 'Work')
  expect(journal).not.toBe('')
  await changeEditorSettingsElsewhere(page, { dailyNotebook: journal })
  await row(page, 'Work').click({ button: 'right' })
  await pickMenuItem(page, 'Open as Workspace')
  await expect(anyWorkspace(page)).toBeVisible()

  const title = await todayIso(page)
  await page.keyboard.press('Meta+KeyK')
  await paletteField(page).fill('Open Today')
  await expect(palette(page).getByRole('option', { name: /Open Today’s Note/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(titleField(page)).toHaveValue(title)
  await expect(anyWorkspace(page)).toHaveCount(0)
  await expect
    .poll(() => stored(page, title))
    .toEqual([expect.objectContaining({ bookId: journal })])

  await page.getByRole('button', { name: /^All Notes/ }).click()
  await page.keyboard.press('Meta+Alt+KeyT')
  await expect(titleField(page)).toHaveValue(title)
  await page.evaluate(() =>
    globalThis.dispatchEvent(new CustomEvent('devot:open-url', { detail: { kind: 'today' } })),
  )
  await expect(titleField(page)).toHaveValue(title)
  await expect.poll(async () => (await stored(page, title)).length).toBe(1)
})
