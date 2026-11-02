import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
})

const library = (page: Page) => page.getByRole('region', { name: 'Library' })
const overlay = (page: Page) => page.getByRole('dialog', { name: 'Search notes' })
const field = (page: Page) => page.getByRole('textbox', { name: 'Search notes' })
const results = (page: Page) => overlay(page).locator('.phone-note-row')

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Tabs' })

async function openSearch(page: Page) {
  await library(page).getByRole('button', { name: 'Search', exact: true }).click()
  await expect(field(page)).toBeFocused()
}

interface StoredNote {
  id: string
  title: string
  status: string
}

// The memory adapter's own store: a phone has no way yet to create a tag.
async function seed(page: Page) {
  const noteIds = { tagged: 'seeded-tagged', held: 'seeded-held', hashed: 'seeded-hashed' }
  await page.evaluate((ids) => {
    const notes = JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as StoredNote[]
    const copy = (id: string, title: string, status = 'none') => ({
      ...notes[0]!,
      id,
      title,
      status,
    })
    notes.push(
      copy(ids.tagged, 'Seeded tagged'),
      copy(ids.held, 'Seeded held', 'on_hold'),
      copy(ids.hashed, 'About #include'),
    )
    localStorage.setItem('devot.test.notes', JSON.stringify(notes))
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
    localStorage.setItem(
      'devot.test.noteTags',
      JSON.stringify([{ noteId: ids.tagged, tagId: 'seeded-tag', present: true, hlc: '' }]),
    )
  }, noteIds)
  await page.reload()
  await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    ;(globalThis as { devotSeedWelcome?: boolean }).devotSeedWelcome = true
  })
  await page.goto('/')
  await expect(library(page).getByRole('heading', { name: 'Notebooks' })).toBeVisible()
})

test('opens from the Library and the Notes tab, focused, and closes', async ({ page }) => {
  await openSearch(page)
  await page.getByRole('button', { name: 'Close search' }).click()
  await expect(overlay(page)).toBeHidden()
  await tabs(page).getByRole('button', { name: 'Notes' }).click()
  await page
    .getByRole('region', { name: 'All Notes' })
    .getByRole('button', { name: 'Search', exact: true })
    .click()
  await expect(field(page)).toBeFocused()
})

test('the field grows leftwards from the button', async ({ page }) => {
  const look = page.locator('.phone-search-field')
  await openSearch(page)
  await expect(look).toHaveCSS('transform', 'none')
  const box = (await look.boundingBox())!
  const origin = await look.evaluate((el) => getComputedStyle(el).transformOrigin)
  expect(Number.parseFloat(origin)).toBeCloseTo(box.width, 0)
})

test('no query shows chips that fill the field', async ({ page }) => {
  await openSearch(page)
  for (const name of ['Notebooks', 'Status'])
    await expect(overlay(page).getByRole('heading', { name })).toBeVisible()
  await overlay(page).getByRole('button', { name: 'On Hold' }).click()
  await expect(field(page)).toHaveValue('is:on_hold ')
  await overlay(page).getByRole('button', { name: 'Clear Search' }).click()
  await expect(field(page)).toHaveValue('')
  await expect(overlay(page).getByRole('heading', { name: 'Status' })).toBeVisible()
})

test('words find notes, highlighted, and a result opens its note', async ({ page }) => {
  await openSearch(page)
  await field(page).fill('Welcome')
  await expect(results(page).first()).toBeVisible()
  await expect(results(page).first().locator('mark').first()).toHaveText(/welcome/i)
  const mark = await results(page)
    .first()
    .locator('mark')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(mark).not.toBe('rgba(0, 0, 0, 0)')
  await results(page).first().getByRole('button').first().click()
  await expect(overlay(page)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Back' }).first()).toBeVisible()
})

test('in: lists a notebook and shows its name on the row', async ({ page }) => {
  const name = (await library(page)
    .locator('.phone-grouped-open .phone-grouped-label')
    .first()
    .textContent())!
  await openSearch(page)
  await field(page).fill(`in:"${name}"`)
  await expect(results(page).first()).toBeVisible()
  await expect(results(page).first().locator('.phone-note-book')).toHaveText(name)
  await expect(results(page).first().locator('mark')).toHaveCount(0)
})

test('is: filters by status, by ID or by quoted name', async ({ page }) => {
  await seed(page)
  await openSearch(page)
  for (const query of ['is:on_hold', 'is:"On Hold"']) {
    await field(page).fill(query)
    await expect(results(page)).toHaveCount(1)
    await expect(results(page).first()).toContainText('Seeded held')
  }
  await overlay(page).getByRole('button', { name: 'Clear Search' }).click()
  await overlay(page).getByRole('button', { name: 'On Hold' }).click()
  await expect(results(page)).toHaveCount(1)
})

test('#x finds the tag when one has that name, and its chip fills the field', async ({ page }) => {
  await seed(page)
  await openSearch(page)
  await overlay(page).getByRole('button', { name: '#seeded' }).click()
  await expect(field(page)).toHaveValue('#seeded ')
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).first()).toContainText('Seeded tagged')
  await expect(results(page).first().locator('mark')).toHaveCount(0)
})

test('#x is plain text when no tag has that name', async ({ page }) => {
  await seed(page)
  await openSearch(page)
  await field(page).fill('#include')
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).first().locator('.phone-note-title mark')).toHaveText('#include')
})

test('an empty result names the query and hints at #, and clearing returns to the chips', async ({
  page,
}) => {
  await openSearch(page)
  await field(page).fill('zzzz-no-such-words')
  await expect(overlay(page).getByText('Try fewer words, or search a tag with #')).toBeVisible()
  await overlay(page).getByRole('button', { name: 'Clear Search' }).click()
  await expect(overlay(page).getByRole('heading', { name: 'Status' })).toBeVisible()
})

test('Return remembers a search on this device, and its chip fills the field', async ({ page }) => {
  await openSearch(page)
  await expect(overlay(page).getByRole('heading', { name: 'Recent' })).toHaveCount(0)
  await field(page).fill('relay')
  await field(page).press('Enter')
  await page.getByRole('button', { name: 'Close search' }).click()
  await openSearch(page)
  await expect(field(page)).toHaveValue('')
  await overlay(page).getByRole('button', { name: 'relay' }).click()
  await expect(field(page)).toHaveValue('relay')
  const stored = await page.evaluate(() => localStorage.getItem('devot.phone.recentSearches'))
  expect(JSON.parse(stored!)).toEqual(['relay'])
})

test('every button in the overlay is at least 44 points', async ({ page }) => {
  await openSearch(page)
  await field(page).fill('')
  for (const button of await overlay(page).getByRole('button').all()) {
    const box = await button.boundingBox()
    if (!box) continue
    expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(44)
    expect(box.width, await button.innerText()).toBeGreaterThanOrEqual(44)
  }
  await field(page).fill('relay')
  const clear = await overlay(page).getByRole('button', { name: 'Clear Search' }).boundingBox()
  expect(clear!.height).toBeGreaterThanOrEqual(44)
})
