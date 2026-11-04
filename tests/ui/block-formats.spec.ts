import type { Page } from '@playwright/test'
import {
  clipboardWrites,
  expect,
  pickMenuItem,
  shownMenu,
  test,
  openApp,
  type TestWindow,
} from './fixtures'

// Keys are platform-neutral: ControlOrMeta for the command key, selections via Select All, not macOS text-navigation keys.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Format' })
const button = (page: Page, name: string) =>
  toolbar(page).getByRole('button', { name, exact: true })
const lines = (page: Page) => page.locator('.cm-line').allTextContents()

async function newNote(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('')
  // The title clears before the new note's editor replaces the last one.
  await expect(body(page)).toHaveText('')
  await body(page).click()
  await page.keyboard.insertText(text)
}

async function selectAll(page: Page) {
  await page.keyboard.press('ControlOrMeta+a')
  await expect(toolbar(page)).toBeVisible()
}

/** Selects all and hides the toolbar, so only the shortcut can act. */
async function selectAllWithoutToolbar(page: Page) {
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Escape')
  await expect(toolbar(page)).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('the alert button picks the kind from a pop-up', async ({ page }) => {
  await newNote(page, 'Mind the gap')
  await selectAll(page)
  await button(page, 'Alert').click()
  await expect
    .poll(() => shownMenu(page))
    .toEqual(['Note [ ]', 'Tip [ ]', 'Important [ ]', 'Warning [ ]', 'Caution [ ]'])
  await pickMenuItem(page, 'Warning')
  await expect.poll(() => lines(page)).toEqual(['> [!WARNING]', '> Mind the gap'])
  await expect(button(page, 'Alert')).toHaveAttribute('aria-pressed', 'true')

  await button(page, 'Alert').click()
  await expect.poll(() => shownMenu(page)).toContain('Warning [x]')
  await pickMenuItem(page, 'Tip')
  await expect.poll(() => lines(page)).toEqual(['> [!TIP]', '> Mind the gap'])

  await button(page, 'Alert').click()
  await expect.poll(() => shownMenu(page)).toContain('Tip [x]')
  await pickMenuItem(page, 'Tip')
  await expect.poll(() => lines(page)).toEqual(['Mind the gap'])
  await page.keyboard.type('done')
  expect(await lines(page)).toEqual(['done'])

  // Another note uses the same pop-up: it is built once for the window.
  await newNote(page, 'Second')
  await selectAll(page)
  await button(page, 'Alert').click()
  await pickMenuItem(page, 'Note')
  await expect.poll(() => lines(page)).toEqual(['> [!NOTE]', '> Second'])
  const built = await page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) =>
          c.cmd === 'plugin:menu|new' &&
          String((c.args['options'] as { id?: string } | undefined)?.id).startsWith('devot.alert.'),
      ).length,
  )
  expect(built).toBe(5)
})

test('Shift+Cmd+C makes a code block in the editor and copies the URI in the list', async ({
  page,
}) => {
  await newNote(page, 'code')
  await selectAllWithoutToolbar(page)
  await page.keyboard.press('ControlOrMeta+Shift+KeyC')
  expect(await lines(page)).toEqual(['```', 'code', '```'])
  expect(await clipboardWrites(page)).toEqual([])

  const row = page.getByRole('listbox', { name: 'Notes' }).getByRole('option').first()
  await row.click()
  await expect(row).toBeFocused()
  await page.keyboard.press('Meta+Shift+KeyC')
  await expect.poll(() => clipboardWrites(page)).toHaveLength(1)
  expect((await clipboardWrites(page))[0]).toMatch(/^devot:\/\/note\/[0-9a-f-]{36}$/)
  expect(await lines(page)).toEqual(['```', 'code', '```'])
})

test('Return on an empty list item leaves it, a blank line apart; a quote goes on', async ({
  page,
}) => {
  await newNote(page, '- one\n- two')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  expect(await lines(page)).toEqual(['- one', '- two', '', 'after'])

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText('> note')
  await page.keyboard.press('Enter')
  await expect.poll(() => lines(page)).toEqual(['> note', '> '])
  await page.keyboard.press('Enter')
  await page.keyboard.type('after')
  expect(await lines(page)).toEqual(['> note', '>', '> after'])
})
