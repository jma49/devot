import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const library = (page: Page) => page.getByRole('region', { name: 'Library' })
const row = (page: Page, name: string) => library(page).getByRole('button', { name })
const group = (page: Page, name: string) => library(page).getByRole('region', { name })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await expect(library(page)).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`shows the smart rows, notebooks, Templates and Trash, ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    for (const name of ['All Notes', 'Pinned', 'Active', 'Completed', 'Templates', 'Trash'])
      await expect(row(page, name).first()).toBeVisible()
    await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
    const box = await row(page, 'All Notes').boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
    await expect(library(page).getByText(/^\d+ notes/)).toBeVisible()
  })
}

test('draws row icons without a tile, in the text colour', async ({ page }) => {
  const icon = library(page).locator('.phone-row-icon').first()
  await expect(icon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const [iconColor, textColor] = await Promise.all([
    icon.evaluate((el) => getComputedStyle(el).color),
    library(page).evaluate((el) => getComputedStyle(el).color),
  ])
  expect(iconColor).toBe(textColor)
})

test('counts every note on the All Notes row', async ({ page }) => {
  const count = row(page, 'All Notes').locator('.phone-grouped-count')
  await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(0)
  const shown = await count.textContent()
  await expect(library(page).getByText(`${shown} notes`, { exact: false })).toBeVisible()
})

test('a smart row opens the Notes tab', async ({ page }) => {
  await row(page, 'Completed').click()
  const tabs = page.getByRole('navigation', { name: 'Tabs' })
  await expect(tabs.getByRole('button', { name: 'Notes' })).toHaveAttribute('aria-current', 'page')
})

test('a notebook opens its list, and the back button returns', async ({ page }) => {
  const first = group(page, 'Notebooks').locator('.phone-grouped-open').first()
  const name = (await first.locator('.phone-grouped-label').textContent())!
  await first.click()
  await expect(page.getByRole('region', { name })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(library(page)).toBeVisible()
})

test('the new-notebook button adds a notebook', async ({ page }) => {
  // The button does nothing until the core has started, which the first notebook shows.
  await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
  const added = library(page).locator('.phone-grouped-open').filter({ hasText: 'New Notebook' })
  await expect(added).toHaveCount(0)
  await library(page).getByRole('button', { name: 'New Notebook', exact: true }).click()
  await expect(added).toHaveCount(1)
})

test('Notebooks collapses and stays collapsed while the Library is open', async ({ page }) => {
  const head = library(page).getByRole('button', { name: 'Notebooks' })
  const rows = group(page, 'Notebooks').locator('.phone-grouped-open')
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(rows.first()).toBeVisible()
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(rows.first()).toBeHidden()
  await row(page, 'Templates').click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await head.click()
  await expect(rows.first()).toBeVisible()
})

test('a nested notebook is indented, with a guide through its parent icon column', async ({
  page,
}) => {
  await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
  await library(page).getByRole('button', { name: 'New Notebook', exact: true }).click()
  await expect(
    group(page, 'Notebooks').locator('.phone-grouped-open').filter({ hasText: 'New Notebook' }),
  ).toHaveCount(1)
  await page.evaluate(() => {
    const books = JSON.parse(localStorage.getItem('devot.test.books') ?? '[]') as {
      id: string
      name: string
      parentId: string | null
    }[]
    const added = books.find((b) => b.name === 'New Notebook')!
    const parent = books.find(
      (b) => b.id !== added.id && b.parentId === null && b.name !== 'Templates',
    )!
    added.parentId = parent.id
    localStorage.setItem('devot.test.books', JSON.stringify(books))
  })
  await page.reload()
  const disclosure = group(page, 'Notebooks').getByRole('button', { name: /^Show notebooks in/ })
  await disclosure.click()
  const hide = group(page, 'Notebooks').getByRole('button', { name: /^Hide notebooks in/ })
  await expect(hide).toBeVisible()
  const parentRow = group(page, 'Notebooks').locator(
    '.phone-grouped-row:has(.phone-disclosure[aria-expanded="true"])',
  )
  const child = group(page, 'Notebooks').locator('.phone-grouped-row[data-child]')
  await expect(child.locator('.phone-grouped-open')).toHaveCSS('padding-left', '40px')
  const [guide, icon] = await Promise.all([
    child.locator('.phone-row-guide').boundingBox(),
    parentRow.locator('.phone-row-icon').boundingBox(),
  ])
  expect(guide!.width).toBe(1)
  expect(guide!.x + 0.5).toBeCloseTo(icon!.x + icon!.width / 2, 0)
})

test('a tag row has a 10 point dot and a count', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'devot.test.tags',
      JSON.stringify([
        {
          id: 'seeded-tag',
          name: 'seeded',
          nameHlc: '',
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          deletedHlc: null,
          color: 'blue',
          colorHlc: '',
        },
      ]),
    )
  })
  await page.reload()
  const tags = group(page, 'Tags')
  await expect(tags.locator('.phone-tag-dot')).toHaveCSS('width', '10px')
  await expect(tags.locator('.phone-grouped-count')).toHaveText('0')
  await library(page).getByRole('button', { name: 'Tags' }).click()
  await expect(tags.locator('.phone-tag-dot')).toBeHidden()
})

test('a custom tag colour draws its dot as given', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      'devot.test.tags',
      JSON.stringify([
        {
          id: 'seeded-tag',
          name: 'seeded',
          nameHlc: '',
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          deletedHlc: null,
          color: '#ff00aa',
          colorHlc: '',
        },
      ]),
    )
  })
  await page.reload()
  await expect(group(page, 'Tags').locator('.phone-tag-dot')).toHaveCSS(
    'background-color',
    'rgb(255, 0, 170)',
  )
})

test('every button in the Library is at least 44 points', async ({ page }) => {
  for (const button of await library(page).getByRole('button').all()) {
    const box = await button.boundingBox()
    if (!box) continue
    expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(44)
    expect(box.width, await button.innerText()).toBeGreaterThanOrEqual(44)
  }
})

test('a deeply nested notebook keeps room for its name', async ({ page }) => {
  await page.evaluate(() => {
    const books = Array.from({ length: 7 }, (_, i) => ({
      id: `deep-${i}`,
      name: `Long notebook name with a research title ${i}`,
      nameHlc: '',
      parentId: i ? `deep-${i - 1}` : null,
      parentHlc: '',
      sortKey: 'a0',
      sortHlc: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      deletedHlc: null,
      icon: null,
      iconColor: null,
      iconHlc: '',
    }))
    localStorage.setItem('devot.test.books', JSON.stringify(books))
  })
  await page.reload()
  const notebooks = group(page, 'Notebooks')
  for (let level = 0; level < 6; level++) {
    await notebooks
      .getByRole('button', { name: /^Show notebooks in/ })
      .first()
      .click()
  }
  const deepest = notebooks.locator('.phone-grouped-row').filter({ hasText: 'research title 6' })
  await expect(deepest).toBeVisible()
  for (const scale of ['1', '2']) {
    await page.locator('.phone-app').evaluate((app, value) => {
      const shell = app
      shell.style.setProperty('--phone-text-scale', value)
      if (value === '1') delete shell.dataset['textSize']
      else shell.dataset['textSize'] = 'accessibility'
    }, scale)
    const label = (await deepest.locator('.phone-grouped-label').boundingBox())!
    expect(label.width).toBeGreaterThanOrEqual(120)
  }
})
