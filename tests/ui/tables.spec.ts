import type { Page } from '@playwright/test'
import { changeEditorSettingsElsewhere, expect, test } from './fixtures'

// Editor keys are platform-neutral (Tab, Return, Alt+Return, ControlOrMeta for undo); the cursor is placed by typing and
// clicking, never macOS text-navigation keys.

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
  await page.keyboard.press('Enter')
  await page.keyboard.type('w')
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
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  expect(await lines(page)).toEqual([...grown.slice(0, 5), '', 'after'])
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
  await page.keyboard.press('Enter')
  await page.keyboard.type('| 1 | 2 |')
  await page.keyboard.press('Enter')
  await page.keyboard.type('| x \\| y | z |')
  expect(await lines(page)).toEqual([
    '| a      | b   |',
    '| ------ | --- |',
    '| 1      | 2   |',
    '| x \\| y | z   |',
  ])
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

  await page.locator('.cm-line').filter({ hasText: 'intro' }).click()
  await page.keyboard.press('Meta+KeyK')
  await field(page).fill('Delete Column')
  await expect(commands(page).filter({ hasText: 'Delete Column' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()
})

test('outside a table Tab indents and Return starts a line', async ({ page }) => {
  await newNote(page, 'plain')
  // Control+Tab leaves the editor.
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
  expect(await lines(page)).toContain('| --- | :-: |')
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

test('the table bar disables commands that cannot act and marks the alignment', async ({
  page,
}) => {
  await newNote(page, TABLE)
  await expect(bar(page)).toBeVisible()
  const button = (name: string) => bar(page).getByRole('button', { name })
  await expect(button('Move Column Right')).toBeDisabled()
  await expect(button('Delete Row')).toBeDisabled()
  await expect(button('Move Column Left')).toBeEnabled()
  await expect(button('Insert Row Below')).toBeEnabled()
  await expect(bar(page).locator('button[aria-pressed="true"]')).toHaveCount(1)
  await button('Align Column Center').click()
  await expect(button('Align Column Center')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Shift+Tab')
  await expect(button('Move Column Left')).toBeDisabled()
  await expect(button('Move Column Right')).toBeEnabled()
})
