import type { Page } from '@playwright/test'
import {
  bookPicker,
  changeEditorSettingsElsewhere,
  expect,
  paintedBackground,
  paintedColour,
  pickMenuItem,
  test,
  type TestWindow,
} from './fixtures'

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const tree = (page: Page) => page.getByRole('tree', { name: 'Notebooks' })
const book = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
const row = (page: Page, name: string) => book(page, name).locator('> .book-row')
const rowIcon = (page: Page, name: string) => row(page, name).locator('.book-icon')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Change Notebook Icon' })
const search = (page: Page) => dialog(page).getByRole('searchbox', { name: 'Search icons…' })
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name })
const cell = (page: Page, symbol: string) =>
  dialog(page).getByRole('button', { name: symbol, exact: true })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')

async function createBook(page: Page, name: string) {
  await page.getByRole('button', { name: 'New Notebook' }).click()
  const field = page.getByRole('textbox', { name: 'Notebook name' })
  await expect(field).toHaveValue('New Notebook')
  await field.fill(name)
  await field.press('Enter')
  await expect(book(page, name)).toBeVisible()
}

async function openIconDialog(page: Page, name: string) {
  await row(page, name).click({ button: 'right' })
  await pickMenuItem(page, 'Change Icon…')
  await expect(dialog(page)).toBeVisible()
}

/** The symbol names `symbol_png` was asked for so far. */
const rendered = (page: Page) =>
  page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'symbol_png')
      .map((c) => String(c.args['name'])),
  )

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await createBook(page, 'Home')
  await createBook(page, 'Work')
})

test('Change Icon picks a catalog symbol in a colour; it shows in the sidebar, pickers and palette', async ({
  page,
}) => {
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'book.closed')
  await openIconDialog(page, 'Work')
  await expect(search(page)).toBeFocused()
  await expect(dialog(page).getByRole('tab')).toHaveCount(12)
  await expect(tab(page, 'People')).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 'person')).toBeVisible()
  await expect(cell(page, 'person')).toHaveAttribute('tabindex', '0')
  await expect(cell(page, 'person.fill')).toHaveAttribute('tabindex', '-1')

  await search(page).fill('coffee')
  await expect(cell(page, 'mug')).toBeVisible()
  await expect(cell(page, 'cup.and.saucer')).toBeVisible()
  await expect(cell(page, 'person')).toHaveCount(0)
  await expect(tab(page, 'People')).toHaveAttribute('aria-selected', 'false')
  await search(page).fill('zzzz')
  await expect(dialog(page).getByText('No icons found')).toBeVisible()

  await tab(page, 'Nature').click()
  await expect(search(page)).toHaveValue('')
  await expect(tab(page, 'Nature')).toHaveAttribute('aria-selected', 'true')
  await dialog(page).getByRole('radio', { name: 'Green' }).click()
  await cell(page, 'leaf').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'leaf')
  await expect(rowIcon(page, 'Work')).toHaveClass(/tag-color-green/)
  await expect(rowIcon(page, 'Home')).toHaveAttribute('data-symbol', 'book.closed')

  await row(page, 'Work').click()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await expect(bookPicker(page).locator('.book-icon')).toHaveAttribute('data-symbol', 'leaf')
  await bookPicker(page).click()
  const options = page.getByRole('listbox', { name: 'Notebook' })
  await expect(options.getByRole('option', { name: 'Work' }).locator('.book-icon')).toHaveAttribute(
    'data-symbol',
    'leaf',
  )
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Search Notebooks' }).click()
  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  const workRow = palette.locator('.palette-row').filter({ hasText: 'Work' })
  await expect(workRow.locator('.book-icon')).toHaveAttribute('data-symbol', 'leaf')
  await expect(
    palette.locator('.palette-row').filter({ hasText: 'Home' }).locator('.book-icon'),
  ).toHaveAttribute('data-symbol', 'book.closed')
  await palette.getByRole('combobox').press('Escape')
  await palette.getByRole('combobox').press('Escape')

  await page.reload()
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'leaf')
  await expect(rowIcon(page, 'Work')).toHaveClass(/tag-color-green/)
})

test('the dialog opens on the current icon; Revert to Default takes icon and colour off', async ({
  page,
}) => {
  await openIconDialog(page, 'Work')
  await tab(page, 'Travel').click()
  await dialog(page).getByRole('radio', { name: 'Blue' }).click()
  await cell(page, 'airplane').click()
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'airplane')

  await openIconDialog(page, 'Work')
  await expect(tab(page, 'Travel')).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 'airplane')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog(page).getByRole('radio', { name: 'Blue' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await dialog(page).getByRole('button', { name: 'Revert to Default' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'book.closed')
  await expect(rowIcon(page, 'Work')).not.toHaveClass(/tag-color-/)
})

test('Escape and Cancel leave the icon; the keyboard walks the grid and Return picks', async ({
  page,
}) => {
  await openIconDialog(page, 'Work')
  await cell(page, 'person.2').click()
  await openIconDialog(page, 'Work')
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await openIconDialog(page, 'Work')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'person.2')

  // Down goes from the search to the first symbol of what was typed, at once; Right to the next one.
  await openIconDialog(page, 'Work')
  await search(page).fill('team')
  await search(page).press('ArrowDown')
  await expect(cell(page, 'person.2')).toBeFocused()
  await page.keyboard.press('Escape')
  await openIconDialog(page, 'Work')
  await tab(page, 'People').click()
  await search(page).press('ArrowDown')
  await expect(cell(page, 'person')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(cell(page, 'person.fill')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toHaveCount(0)
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'person.fill')
})

test('a symbol paints nothing until its image is in; a category switch keeps the grid box and shows rendered symbols at once', async ({
  page,
}) => {
  await openIconDialog(page, 'Work')
  const box = dialog(page).locator('.icon-grid-box')
  const height = await box.evaluate((el) => el.getBoundingClientRect().height)
  await expect(cell(page, 'person').locator('.icon')).not.toHaveAttribute('data-pending', '')

  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow & { releaseSymbols?: (png: string) => void }
    const held = new Promise<string>((resolve) => {
      w.releaseSymbols = resolve
    })
    w.devotIpcMocks = { ...w.devotIpcMocks, symbol_png: () => held }
  })
  await dialog(page).getByRole('radio', { name: 'Green' }).click()
  await tab(page, 'Travel').click()
  const pending = cell(page, 'airplane').locator('.icon')
  await expect(pending).toHaveAttribute('data-pending', '')
  // Coloured, and still nothing is painted.
  await expect(pending).toHaveClass(/book-icon-colored/)
  await expect(pending).toBeHidden()
  expect(await box.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)

  await page.evaluate((png) => {
    ;(globalThis as unknown as { releaseSymbols: (png: string) => void }).releaseSymbols(png)
  }, ONE_PIXEL_PNG)
  await expect(pending).toBeVisible()
  await expect(pending).not.toHaveAttribute('data-pending', '')
  // The config turns Reduce Motion on.
  expect(await pending.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')

  await tab(page, 'People').click()
  await expect(cell(page, 'person').locator('.icon')).not.toHaveAttribute('data-pending', '')
  expect(await cell(page, 'person').locator('.icon').getAttribute('data-arrives')).toBeNull()
  expect(await box.evaluate((el) => el.getBoundingClientRect().height)).toBe(height)
})

test('a Lucide icon can be picked in the SF style and stays Lucide; Revert follows the style again', async ({
  page,
}) => {
  const segment = (name: string) => dialog(page).getByRole('button', { name, exact: true })
  await openIconDialog(page, 'Work')
  await expect(segment('SF Symbols')).toHaveAttribute('aria-pressed', 'true')
  await segment('Lucide').click()
  await expect(segment('Lucide')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog(page).getByRole('tab')).toHaveCount(12)
  await search(page).fill('coffee')
  await dialog(page).getByRole('radio', { name: 'Blue' }).click()
  await cell(page, 'coffee').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-lucide', 'coffee')
  await expect(rowIcon(page, 'Work')).toHaveClass(/icon-svg/)
  await expect(rowIcon(page, 'Work')).toHaveClass(/tag-color-blue/)
  await expect(rowIcon(page, 'Home')).toHaveAttribute('data-symbol', 'book.closed')

  await row(page, 'Work').click()
  await expect(page.locator('.toolbar-title .book-icon')).toHaveAttribute('data-lucide', 'coffee')

  await page.reload()
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-lucide', 'coffee')

  await openIconDialog(page, 'Work')
  await expect(segment('Lucide')).toHaveAttribute('aria-pressed', 'true')
  await expect(tab(page, 'Home')).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 'coffee')).toHaveAttribute('aria-pressed', 'true')
  await dialog(page).getByRole('button', { name: 'Revert to Default' }).click()
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'book.closed')
  await expect(rowIcon(page, 'Work')).not.toHaveClass(/tag-color-/)
})

test('without an icon the dialog opens on the Icon style setting; an SF pick stays SF under Lucide', async ({
  page,
}) => {
  const segment = (name: string) => dialog(page).getByRole('button', { name, exact: true })
  await openIconDialog(page, 'Work')
  await cell(page, 'person').click()
  await changeEditorSettingsElsewhere(page, { iconStyle: 'lucide' })
  await expect(rowIcon(page, 'Work')).toHaveAttribute('data-symbol', 'person')
  await openIconDialog(page, 'Home')
  await expect(segment('Lucide')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await openIconDialog(page, 'Work')
  await expect(segment('SF Symbols')).toHaveAttribute('aria-pressed', 'true')
})

test('only the symbols in view are rendered', async ({ page }) => {
  await openIconDialog(page, 'Work')
  // A search that finds most of the catalog: far more than the grid shows.
  await search(page).fill('e')
  const results = dialog(page).locator('.icon-cell')
  await expect.poll(() => results.count()).toBeGreaterThan(150)
  const found = await results.evaluateAll((cells) =>
    cells.map((c) => c.getAttribute('data-symbol') ?? ''),
  )
  await expect(cell(page, found[0]!)).toBeVisible()
  const asked = new Set(await rendered(page))
  const drawn = found.filter((name) => asked.has(name))
  expect(drawn.length).toBeGreaterThan(0)
  expect(drawn.length).toBeLessThan(found.length)
  expect(asked.has(found.at(-1)!)).toBe(false)
  await results.last().scrollIntoViewIfNeeded()
  await expect.poll(async () => (await rendered(page)).includes(found.at(-1)!)).toBe(true)
})

test('under Lucide the default notebook icon is a line drawing in the accent colour, not a filled square', async ({
  page,
}) => {
  await changeEditorSettingsElsewhere(page, { iconStyle: 'lucide' })
  const icon = rowIcon(page, 'Work')
  await expect(icon).toHaveClass(/icon-svg/)
  expect(await paintedBackground(icon)).toBe('rgba(0, 0, 0, 0)')
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-accent-text)'
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  })
  expect(paintedColour(await icon.evaluate((el) => getComputedStyle(el).color))).toBe(
    paintedColour(accent),
  )
})
