import type { Page } from '@playwright/test'
import {
  changeShortcutsElsewhere,
  expect,
  mockTauri,
  shownMenu,
  storedShortcuts,
  test,
  type TestWindow,
} from './fixtures'

// Rust stores shortcut changes and tells every window (`devot://keyboard-shortcuts-changed`, sent in the page
// as `devot:keyboard-shortcuts-changed`), which rebinds its keys and menus at once.

// ControlOrMeta is Command on macOS and Control elsewhere (CI runs Linux); the recorder stores and shows it so.
const MAC = process.platform === 'darwin'
const MOD = MAC ? 'Mod' : 'Ctrl'
const withMod = (rest: string) => (MAC ? `${rest}\u2318` : `\u2303${rest}`)

const section = (page: Page) => page.getByRole('region', { name: 'Keyboard Shortcuts' })
const search = (page: Page) =>
  section(page).getByRole('searchbox', { name: 'Filter Shortcuts\u2026' })
/** By registry ID: labels repeat, with a scope after them. */
const row = (page: Page, id: string) => section(page).locator(`li[data-command="${id}"]`)
const rows = (page: Page) => section(page).getByRole('listitem')
const more = (page: Page) => page.getByRole('button', { name: 'More' })
const resetAll = (page: Page) => page.getByRole('menuitem', { name: 'Reset All Shortcuts\u2026' })
const recorder = (page: Page, command: string) =>
  section(page).getByRole('button', { name: new RegExp(`^${command} shortcut`) })
const status = (page: Page) => section(page).getByRole('status')

async function openSettings(page: Page) {
  await page.goto('/settings.html')
  await page.getByRole('tab', { name: 'Keyboard', exact: true }).click()
  await expect(section(page).getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
}

async function record(page: Page, command: string, keys: string) {
  await recorder(page, command).click()
  await expect(recorder(page, command)).toHaveAttribute('aria-pressed', 'true')
  await expect(recorder(page, command)).toHaveText('Type Shortcut\u2026')
  await page.keyboard.press(keys)
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

test('lists every command in a card per group, with its keys and what can be done with them', async ({
  page,
}) => {
  await openSettings(page)
  await expect(section(page).getByRole('table')).toHaveCount(0)
  await expect(section(page).getByRole('heading', { level: 3 })).toHaveText([
    'App',
    'Notes',
    'Notebooks',
    'Tags',
    'View',
    'Search',
    'Find',
    'Edit',
    'Format',
    'Tables',
    'Images',
  ])
  const format = section(page).getByRole('region', { name: 'Format' })
  await expect(format.locator('li[data-command="format.bold"]')).toContainText('Bold')
  await expect(
    row(page, 'format.bold').getByRole('button', { name: 'Copy the keystroke for Bold' }),
  ).toBeEnabled()
  await expect(row(page, 'image.sizeHalf')).toContainText('Image Size: Half Width')
  await expect(row(page, 'insert.table')).toContainText('In the editor')
  await expect(row(page, 'list.selectAll')).toContainText('Select All Notes')
  await expect(row(page, 'list.selectAll')).toContainText('In a note list')
  await expect(row(page, 'note.addTag')).toContainText('Add Tag to Selected Notes\u2026')
  await expect(row(page, 'note.addTag')).toContainText('In the note list')
  await expect(recorder(page, 'Bold')).toHaveAccessibleName('Bold shortcut: \u2318B')
  await expect(recorder(page, 'Bold')).toHaveText('\u2318B')
  await expect(row(page, 'format.bold')).toContainText('In the editor')
  await expect(recorder(page, 'Increase Font Size')).toHaveAccessibleName(
    'Increase Font Size shortcut: \u2318= and \u21e7\u2318=',
  )
  await expect(recorder(page, 'Copy Note ID')).toHaveText('Record Shortcut')
  await expect(row(page, 'note.copyId').getByRole('button', { name: /^Clear/ })).toBeDisabled()
  await expect(row(page, 'format.bold').getByRole('button', { name: /^Reset/ })).toBeDisabled()
  await expect(row(page, 'format.bold')).not.toHaveAttribute('data-customized')

  await expect(more(page)).toHaveAttribute('aria-haspopup', 'menu')
  await more(page).click()
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible()
  await expect(resetAll(page)).toBeFocused()
  await expect(resetAll(page)).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more(page)).toBeFocused()
})

test('the More button is on the Keyboard pane only', async ({ page }) => {
  await openSettings(page)
  await expect(more(page)).toBeVisible()
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await expect(more(page)).toHaveCount(0)
})

test('the filter narrows the groups to the commands that match', async ({ page }) => {
  await openSettings(page)
  const all = await rows(page).count()
  expect(all).toBeGreaterThan(100)
  await search(page).fill('bold')
  await expect(rows(page)).toHaveCount(1)
  await expect(section(page).getByRole('heading', { level: 3 })).toHaveText(['Format'])
  await expect(row(page, 'format.bold')).toBeVisible()
  await search(page).fill('\u2318K')
  await expect(row(page, 'palette.open')).toBeVisible()
  await expect(row(page, 'format.bold')).toHaveCount(0)
  await search(page).fill('cmd+k')
  await expect(row(page, 'palette.open')).toBeVisible()
  await expect(rows(page)).toHaveCount(1)
  await search(page).fill('shift+enter')
  await expect(row(page, 'edit.plainNewline')).toBeVisible()
  await search(page).fill('no such command')
  await expect(rows(page)).toHaveCount(0)
  await expect(section(page).getByRole('heading', { level: 3 })).toHaveCount(0)
  await expect(section(page)).toContainText('No shortcut matches.')
  await search(page).fill('')
  await expect(rows(page)).toHaveCount(all)
})

test('records a new key, and announces it', async ({ page }) => {
  await openSettings(page)
  await record(page, 'Bold', 'ControlOrMeta+Alt+KeyB')
  await expect(recorder(page, 'Bold')).toHaveAttribute('aria-pressed', 'false')
  await expect(recorder(page, 'Bold')).toHaveText(withMod('\u2325') + 'B')
  await expect(status(page)).toHaveText(`Bold: ${withMod('\u2325')}B`)
  await expect(row(page, 'format.bold')).toHaveAttribute('data-customized', 'true')
  await expect(row(page, 'format.bold').getByRole('button', { name: /^Reset/ })).toBeVisible()
  expect(await storedShortcuts(page)).toEqual({ 'format.bold': [`${MOD}+Alt+B`] })
  await expect(recorder(page, 'Bold')).toBeFocused()
})

test('waits for a key after modifiers, ignores composing, and Escape cancels', async ({ page }) => {
  await openSettings(page)
  await recorder(page, 'Italic').click()
  await page.keyboard.down('Shift')
  await page.keyboard.up('Shift')
  // Keys an input method is composing are its own.
  await recorder(page, 'Italic').evaluate((el) => {
    const w = globalThis as unknown as {
      KeyboardEvent: new (type: string, init: Record<string, unknown>) => unknown
    }
    ;(el as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(
      new w.KeyboardEvent('keydown', {
        key: 'Process',
        code: 'KeyN',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect(recorder(page, 'Italic')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(recorder(page, 'Italic')).toHaveAttribute('aria-pressed', 'false')
  await expect(recorder(page, 'Italic')).toHaveText('\u2318I')
  await expect(status(page)).toHaveText('Recording canceled.')
  expect(await calls(page, 'keyboard_shortcuts_set')).toEqual([])
})

test('refuses keys macOS keeps, Edit menu keys and keys that type text', async ({ page }) => {
  await openSettings(page)
  await record(page, 'Bold', 'Meta+Comma')
  const refused = '\u2318, is kept by macOS or the app menu and cannot be used.'
  await expect(row(page, 'format.bold')).toContainText(refused)
  await expect(status(page)).toHaveText(refused)
  await expect(recorder(page, 'Bold')).toHaveText('\u2318B')

  await record(page, 'Bold', 'Meta+KeyZ')
  await expect(row(page, 'format.bold')).toContainText('\u2318Z is an Edit menu key')

  await record(page, 'Bold', 'KeyJ')
  await expect(row(page, 'format.bold')).toContainText(
    'J would type text; shortcuts that work while you type need Command or Control.',
  )
  // On a note list row a plain key is fine.
  await record(page, 'Duplicate', 'KeyJ')
  await expect(recorder(page, 'Duplicate')).toHaveText('J')
  expect(await storedShortcuts(page)).toEqual({ 'note.duplicate': ['J'] })
})

test('asks before taking a key from another command', async ({ page }) => {
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: '\u2318K is already used by Command Palette.' })

  await record(page, 'Bold', 'Meta+KeyK')
  await expect(dialog).toContainText(
    'Use it for Bold instead? Command Palette will no longer have it.',
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(recorder(page, 'Bold')).toHaveText('\u2318B')
  expect(await calls(page, 'keyboard_shortcuts_set')).toEqual([])

  await record(page, 'Bold', 'Meta+KeyK')
  await dialog.getByRole('button', { name: 'Reassign' }).click()
  await expect(recorder(page, 'Bold')).toHaveText('\u2318K')
  await expect(recorder(page, 'Command Palette')).toHaveText('Record Shortcut')
  expect(await storedShortcuts(page)).toEqual({ 'format.bold': ['Mod+K'], 'palette.open': [] })

  await row(page, 'palette.open')
    .getByRole('button', { name: /^Reset/ })
    .click()
  await page
    .getByRole('dialog', { name: '\u2318K is already used by Bold.' })
    .getByRole('button', { name: 'Reassign' })
    .click()
  await expect(recorder(page, 'Command Palette')).toHaveText('\u2318K')
  await expect(recorder(page, 'Bold')).toHaveText('Record Shortcut')
  expect(await storedShortcuts(page)).toEqual({ 'format.bold': [] })

  // A key used only where Bold never works is not a clash.
  await record(page, 'Bold', 'ControlOrMeta+Shift+KeyM')
  await expect(recorder(page, 'Bold')).toHaveText(withMod('\u21e7') + 'M')
})

test('clears a key, resets one and resets all', async ({ page }) => {
  await openSettings(page)
  // From the keyboard: a button with nothing more to do keeps the focus.
  const clear = row(page, 'format.italic').getByRole('button', {
    name: 'Clear the shortcut for Italic',
  })
  await clear.focus()
  await page.keyboard.press('Space')
  await expect(recorder(page, 'Italic')).toHaveText('Record Shortcut')
  await expect(status(page)).toHaveText('Italic: None')
  await expect(clear).toBeDisabled()
  await expect(clear).toBeFocused()
  await page.keyboard.press('Space')
  await expect(clear).toBeFocused()
  expect(await calls(page, 'keyboard_shortcuts_set')).toHaveLength(1)
  await record(page, 'Focus Mode', 'ControlOrMeta+Alt+KeyJ')
  await expect(recorder(page, 'Focus Mode')).toHaveText(withMod('\u2325') + 'J')
  expect(await storedShortcuts(page)).toEqual({
    'format.italic': [],
    'view.focus': [`${MOD}+Alt+J`],
  })

  const reset = row(page, 'format.italic').getByRole('button', {
    name: 'Reset the shortcut for Italic',
  })
  await reset.focus()
  await page.keyboard.press('Space')
  await expect(recorder(page, 'Italic')).toHaveText('\u2318I')
  expect(await storedShortcuts(page)).toEqual({ 'view.focus': [`${MOD}+Alt+J`] })
  await expect(reset).toBeDisabled()
  await expect(reset).toBeFocused()

  const confirm = page.getByRole('dialog', { name: 'Reset every shortcut to its default?' })
  await more(page).click()
  await resetAll(page).click()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(more(page)).toBeFocused()
  await expect(recorder(page, 'Focus Mode')).toHaveText(withMod('\u2325') + 'J')
  await page.keyboard.press('ArrowDown')
  await expect(resetAll(page)).toBeFocused()
  await page.keyboard.press('Space')
  await confirm.getByRole('button', { name: 'Reset All' }).click()
  await expect(recorder(page, 'Focus Mode')).toHaveText('\u21e7\u2318D')
  await expect(more(page)).toBeFocused()
  expect(await storedShortcuts(page)).toEqual({})
  await more(page).click()
  await expect(resetAll(page)).toBeDisabled()
  await page.keyboard.press('Space')
  await expect(confirm).toBeHidden()
})

test('follows changes made in another window', async ({ page }) => {
  await openSettings(page)
  await changeShortcutsElsewhere(page, { 'format.bold': ['Mod+Alt+B'] })
  await expect(recorder(page, 'Bold')).toHaveText('\u2325\u2318B')
  await expect(row(page, 'format.bold').getByRole('button', { name: /^Reset/ })).toBeEnabled()
})

test('a shortcut changed in Settings works in the main window at once', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await page.getByRole('textbox', { name: 'Title' }).fill('Keys')
  const body = page.getByRole('textbox', { name: 'Note body' })
  await body.click()
  await page.keyboard.insertText('alpha beta')
  const rows = page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
  await rows.first().click({ button: 'right' })
  await expect.poll(() => shownMenu(page)).toContain('Duplicate CmdOrCtrl+D')
  await page.locator('.cm-line').first().dblclick()
  const boldButton = page.getByRole('toolbar', { name: 'Format' }).getByRole('button', {
    name: 'Bold',
    exact: true,
  })
  const boldKey = page.getByRole('tooltip').locator('kbd')
  await boldButton.hover()
  await expect(boldKey).toHaveText('\u2318B')

  const settings = await context.newPage()
  await mockTauri(settings)
  await openSettings(settings)
  await record(settings, 'Focus Mode', 'ControlOrMeta+Alt+KeyJ')
  await record(settings, 'Bold', 'ControlOrMeta+Alt+KeyB')
  await record(settings, 'Duplicate', 'KeyJ')
  await record(settings, 'Command Palette', 'ControlOrMeta+Alt+KeyP')
  await changeShortcutsElsewhere(page, await storedShortcuts(settings))
  await settings.close()
  // The toolbar hides while the editor lacks the keyboard; shown again, it names the new key.
  await page.bringToFront()
  await page.keyboard.press('ControlOrMeta+End')
  await expect(page.getByRole('toolbar', { name: 'Format' })).toBeHidden()
  await page.locator('.cm-line').first().dblclick()
  await boldButton.hover()
  await expect(boldKey).toHaveText(`${withMod('\u2325')}B`)

  const focusButton = page.getByRole('button', { name: 'Focus Mode' })
  await expect(focusButton).toHaveAttribute('title', `Focus Mode (${withMod('\u2325')}J)`)
  await body.click()
  await page.keyboard.press('Meta+Shift+KeyD')
  await expect(focusButton).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('ControlOrMeta+Alt+KeyJ')
  await expect(focusButton).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ControlOrMeta+Alt+KeyJ')
  await expect(focusButton).toHaveAttribute('aria-pressed', 'false')

  await page.locator('.cm-line').first().dblclick()
  await page.keyboard.press('ControlOrMeta+KeyB')
  await expect(page.locator('.cm-content')).toHaveText('alpha beta')
  await page.locator('.cm-line').first().dblclick()
  await page.keyboard.press('ControlOrMeta+Alt+KeyB')
  await expect(page.locator('.cm-content')).toHaveText(/\*\*(alpha|beta)\*\*/)

  const mod = MAC ? 'CmdOrCtrl' : 'Ctrl'
  await expect
    .poll(async () => (await calls(page, 'format_menu_set')).at(-1)?.['keys'])
    .toMatchObject({ 'format.bold': MAC ? `Alt+${mod}+B` : `${mod}+Alt+B` })
  expect((await calls(page, 'command_menu_set')).at(-1)).toEqual({
    keys: {
      'note.history': 'Alt+CmdOrCtrl+Y',
      'palette.open': MAC ? 'Alt+CmdOrCtrl+P' : 'Ctrl+Alt+P',
      'view.sidebar': 'CmdOrCtrl+/',
      'view.togglePreview': 'CmdOrCtrl+E',
      'view.split': 'CmdOrCtrl+P',
      'view.syncScroll': null,
      'app.backups': null,
    },
  })

  await rows.first().click()
  await page.keyboard.press('KeyJ')
  await expect(rows).toHaveCount(2)
  await rows.first().click({ button: 'right' })
  await expect.poll(() => shownMenu(page)).toContain('Duplicate J')

  const palette = page.getByRole('dialog', { name: 'Command Palette' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+KeyK')
  await expect(palette).toBeHidden()
  await page.keyboard.press('ControlOrMeta+Alt+KeyP')
  const field = palette.getByRole('combobox', { name: 'Command Palette' })
  await expect(field).toBeFocused()
  await field.fill('focus mode')
  await expect(palette.getByRole('option', { name: /Focus Mode/ })).toContainText(
    withMod('\u2325') + 'J',
  )
})
