import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

// Editing a Markdown table in the editor. Editor keys are platform-neutral
// (Tab, Return, Alt+Return, ControlOrMeta for undo), and the cursor is placed
// by typing and clicking, never with macOS text-navigation keys. The palette
// opens with Meta+P like in the other specs: app-level shortcuts check metaKey.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Command Palette' })
const commands = (page: Page) =>
  palette(page).getByRole('listbox', { name: 'Results' }).getByRole('option')

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

/** Runs a palette command by its exact name. */
async function runFromPalette(page: Page, name: string) {
  await page.keyboard.press('Meta+KeyK')
  await expect(field(page)).toBeFocused()
  await field(page).fill(name)
  const option = commands(page).filter({ hasText: name }).first()
  await expect(option).toBeVisible()
  await option.click()
  await expect(palette(page)).toBeHidden()
}

const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

test('Tab, Shift+Tab, Return and Option+Return move through and grow a table', async ({ page }) => {
  await newNote(page, TABLE)
  // The cursor is in the last cell: Tab adds a row and formats the table.
  await page.keyboard.press('Tab')
  expect(await lines(page)).toEqual([
    '| a   | b   |',
    '| --- | --- |',
    '| 1   | 2   |',
    '|     |     |',
  ])
  await expect(body(page)).toBeFocused()
  await page.keyboard.type('x')
  await page.keyboard.press('Tab')
  await page.keyboard.type('y')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('z')
  // Return in the last row adds one, in the same column.
  await page.keyboard.press('Enter')
  await page.keyboard.type('w')
  // Option+Return inserts a row below.
  await page.keyboard.press('Alt+Enter')
  const grown = [
    '| a   | b   |',
    '| --- | --- |',
    '| 1   | 2   |',
    '| xz  | y   |',
    '| w   |     |',
    '|     |     |',
  ]
  expect(await lines(page)).toEqual(grown)
  // Return on the empty last row leaves the table.
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  expect(await lines(page)).toEqual([...grown.slice(0, 5), '', 'after'])
  // Each table command is one undo step.
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual([...grown.slice(0, 5), '', ''])
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual(grown)
})

test('a table typed entirely by hand keeps its columns', async ({ page }) => {
  await newNote(page, '')
  await page.keyboard.type('| a | b |')
  await page.keyboard.press('Enter')
  await page.keyboard.type('|-|-|')
  // Return starts a row at its first cell; typing the row's pipes moves through its cells.
  await page.keyboard.press('Enter')
  await page.keyboard.type('| 1 | 2 |')
  await page.keyboard.press('Enter')
  // An escaped pipe stays in its cell.
  await page.keyboard.type('| x \\| y | z |')
  expect(await lines(page)).toEqual([
    '| a      | b   |',
    '| ------ | --- |',
    '| 1      | 2   |',
    '| x \\| y | z   |',
  ])
  // Return on the empty row after it leaves the table.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  expect(await lines(page)).toEqual([
    '| a      | b   |',
    '| ------ | --- |',
    '| 1      | 2   |',
    '| x \\| y | z   |',
    '',
    'after',
  ])
})

test('a table typed by hand without outer pipes keeps its columns', async ({ page }) => {
  await newNote(page, '')
  await page.keyboard.type('a | b')
  await page.keyboard.press('Enter')
  await page.keyboard.type('--|--')
  // Return on the delimiter row starts the first row at its first cell.
  await page.keyboard.press('Enter')
  // Its pipe ends the first cell; the last one is formatted when it is left.
  await page.keyboard.type('1 | 2')
  expect(await lines(page)).toEqual(['| a   | b   |', '| --- | --- |', '| 1   | 2    |'])
})

test('a pipe typed inside a cell text stays text', async ({ page }) => {
  await newNote(page, '| a | b |\n|---|---|')
  await page.keyboard.press('Enter')
  await page.keyboard.type('| ab')
  // Between a and b (a plain arrow key moves one character on every platform).
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('|')
  expect(await lines(page)).toEqual(['| a   | b   |', '| --- | --- |', '| a|b    |     |'])
})

test('the palette runs table commands while the cursor is in a table', async ({ page }) => {
  await newNote(page, `intro\n\n${TABLE}`)
  await page.locator('.cm-line').filter({ hasText: '| 1 | 2 |' }).click()
  await runFromPalette(page, 'Align Column Right')
  expect(await lines(page)).toEqual([
    'intro',
    '',
    '| a   |   b |',
    '| --- | --: |',
    '| 1   |   2 |',
  ])
  await runFromPalette(page, 'Delete Column')
  expect(await lines(page)).toEqual(['intro', '', '| a   |', '| --- |', '| 1   |'])
  await expect(body(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  expect(await lines(page)).toEqual([
    'intro',
    '',
    '| a   |   b |',
    '| --- | --: |',
    '| 1   |   2 |',
  ])

  // Outside the table the palette does not offer them.
  await page.locator('.cm-line').filter({ hasText: 'intro' }).click()
  await page.keyboard.press('Meta+KeyK')
  await field(page).fill('Delete Column')
  await expect(commands(page).filter({ hasText: 'Delete Column' })).toHaveCount(0)
  // Escape clears the query first, then closes the palette.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
})

test('outside a table Tab indents and Return starts a line', async ({ page }) => {
  await newNote(page, 'plain')
  // Tab indents the line (Control+Tab leaves the editor), Shift+Tab takes it back.
  await page.keyboard.press('Tab')
  await expect.poll(() => lines(page)).toEqual(['  plain'])
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => lines(page)).toEqual(['plain'])
  await expect(body(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  expect(await lines(page)).toEqual(['plain', 'next'])
})

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Table', exact: true })

test('the table bar shows above the caret row and runs a command', async ({ page }) => {
  await newNote(page, 'intro\n\n' + TABLE)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page).getByRole('button')).toHaveCount(13)
  const barBox = await bar(page).boundingBox()
  const row = await page.locator('.cm-line', { hasText: '| 1' }).boundingBox()
  expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(row!.y + 1)
  await bar(page).getByRole('button', { name: 'Align Column Center' }).click()
  expect(await lines(page)).toContain('| :-: | --- |')
  await expect(body(page)).toBeFocused()
})

test('the table bar tooltips show the bound key', async ({ page }) => {
  await newNote(page, TABLE)
  await bar(page).getByRole('button', { name: 'Insert Row Below' }).hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('Insert Row Below')
  await expect(tip.locator('kbd')).toHaveText(/\S/)
})

test('the table bar hides outside a table and while text is selected', async ({ page }) => {
  await newNote(page, 'plain\n\n' + TABLE)
  await expect(bar(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+a')
  await expect(bar(page)).toBeHidden()
  await page.locator('.cm-line', { hasText: 'plain' }).click()
  await expect(bar(page)).toBeHidden()
})

test('the table bar follows the Toolbar setting', async ({ page }) => {
  await newNote(page, TABLE)
  await expect(bar(page)).toBeVisible()
  await changeEditorSettingsElsewhere(page, { toolbar: false })
  await expect(bar(page)).toBeHidden()
  await changeEditorSettingsElsewhere(page, { toolbar: true })
  await body(page).click()
  await expect(bar(page)).toBeVisible()
})
