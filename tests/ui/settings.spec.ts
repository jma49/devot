import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  test,
  type TestWindow,
} from './fixtures'

// The Settings window: the Editor section (local editor settings, applied
// live in every window) and the Usage Data section (the local usage events
// by type, a list of every stored event, and a button that clears them).

const AT = Date.UTC(2026, 9, 10, 9, 30)

// What `usage_list` returns: newest first.
const EVENTS = [
  {
    id: 4,
    at: AT + 3000,
    name: 'search.run',
    properties: { scope: 'view', clauses: 1, results: '0' },
  },
  { id: 3, at: AT + 2000, name: 'note.created', properties: { from: 'new_note' } },
  {
    id: 2,
    at: AT + 1000,
    name: 'search.run',
    properties: { scope: 'all', clauses: 2, results: '2-5' },
  },
  // From another Devot version: shown by its name.
  { id: 1, at: AT, name: 'sync.finished', properties: { durationMs: 40 } },
]

const section = (page: Page) => page.getByRole('region', { name: 'Usage Data' })
const byType = (page: Page) => section(page).getByRole('table', { name: 'Events by type' })
const list = (page: Page) => section(page).getByRole('list', { name: 'Stored events' })

async function open(page: Page, events: unknown[] | { error: string }) {
  await page.addInitScript((stored) => {
    const w = globalThis as unknown as TestWindow
    let current = stored
    w.devotIpcMocks = {
      usage_list: () => {
        if (!Array.isArray(current)) throw current.error
        return current
      },
      usage_clear: () => {
        current = []
        return null
      },
    }
  }, events)
  await openSettings(page, 'Usage')
}

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) => (globalThis as unknown as TestWindow).devotIpcCalls.filter((call) => call.cmd === c),
    cmd,
  )

test('the settings window has a Usage Data section', async ({ page }) => {
  await open(page, [])
  await expect(section(page).getByRole('heading', { name: 'Usage Data' })).toBeVisible()
  await expect(section(page)).toContainText('never includes note content, titles or names')
  await expect(section(page)).toContainText('No usage events are stored.')
  await expect(section(page).getByRole('button', { name: 'Clear Usage Data\u2026' })).toBeDisabled()
  await expect(section(page).getByRole('button', { name: 'Show Events' })).toBeDisabled()
})

test('shows the stored events by type, and each one on request', async ({ page }) => {
  await open(page, EVENTS)
  await expect(section(page)).toContainText('4 events are stored on this Mac.')
  await expect(byType(page).getByRole('row')).toHaveText([
    'EventCount',
    'Search run2',
    'Note created1',
    'sync.finished1',
  ])

  await expect(list(page)).toBeHidden()
  const show = section(page).getByRole('button', { name: 'Show Events' })
  await expect(show).toHaveAttribute('aria-expanded', 'false')
  await show.click()
  const rows = list(page).getByRole('listitem')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toContainText('Search run')
  await expect(rows.nth(0)).toContainText('scope: view, clauses: 1, results: 0')
  await expect(rows.nth(1)).toContainText('Note created')
  await expect(rows.nth(1)).toContainText('from: new_note')
  await expect(rows.nth(3)).toContainText('sync.finished')
  await expect(rows.nth(3).locator('time')).toHaveAttribute('datetime', new Date(AT).toISOString())

  const hide = section(page).getByRole('button', { name: 'Hide Events' })
  await expect(hide).toHaveAttribute('aria-expanded', 'true')
  await hide.click()
  await expect(list(page)).toBeHidden()
})

test('clears the stored events after asking', async ({ page }) => {
  await open(page, EVENTS)
  await section(page).getByRole('button', { name: 'Show Events' }).click()
  await expect(list(page).getByRole('listitem')).toHaveCount(4)
  const clear = section(page).getByRole('button', { name: 'Clear Usage Data\u2026' })
  const confirm = page.getByRole('dialog', { name: 'Clear all usage data?' })

  await clear.click()
  await expect(confirm).toContainText('This cannot be undone.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
  await expect(list(page).getByRole('listitem')).toHaveCount(4)
  expect(await calls(page, 'usage_clear')).toHaveLength(0)

  await clear.click()
  await confirm.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(section(page)).toContainText('No usage events are stored.')
  await expect(byType(page)).toBeHidden()
  await expect(list(page)).toBeHidden()
  expect(await calls(page, 'usage_clear')).toHaveLength(1)
})

test('a failed clear stays reported after the window reloads', async ({ page }) => {
  await open(page, EVENTS)
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { ...w.devotIpcMocks, usage_clear: { error: 'E_USAGE_STORE_FAILED' } }
  })
  await section(page).getByRole('button', { name: 'Clear Usage Data\u2026' }).click()
  await page
    .getByRole('dialog', { name: 'Clear all usage data?' })
    .getByRole('button', { name: 'Clear', exact: true })
    .click()
  const alert = section(page).getByRole('alert')
  await expect(alert).toHaveText('The usage data could not be cleared (E_USAGE_STORE_FAILED).')
  await page.evaluate(() =>
    (globalThis as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(
      new (globalThis as unknown as { Event: new (t: string) => unknown }).Event('focus'),
    ),
  )
  await expect(alert).toBeVisible()
  await expect(section(page)).toContainText('4 events are stored on this Mac.')
})

test('reloads the events when the window comes back to the front', async ({ page }) => {
  await open(page, [])
  await expect(section(page)).toContainText('No usage events are stored.')
  await page.evaluate(
    (events) => {
      const w = globalThis as unknown as TestWindow & { dispatchEvent(e: unknown): void }
      w.devotIpcMocks = { usage_list: events }
      w.dispatchEvent(
        new (globalThis as unknown as { Event: new (t: string) => unknown }).Event('focus'),
      )
    },
    EVENTS.slice(0, 1),
  )
  await expect(section(page)).toContainText('1 event is stored on this Mac.')
})

test('shows why the events could not be read', async ({ page }) => {
  await open(page, { error: 'E_USAGE_OPEN_FAILED' })
  await expect(section(page).getByRole('alert')).toHaveText(
    'The usage data could not be read (E_USAGE_OPEN_FAILED).',
  )
})

/** What Rust sends every window after a change made elsewhere. */
const changedElsewhere = changeEditorSettingsElsewhere

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Settings panes' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })

test('a navigation column of panes on the left, General first', async ({ page }) => {
  await page.goto('/settings.html')
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
  await expect(tabs(page).getByRole('tab')).toHaveText([
    'General',
    'Editing',
    'Preview',
    'Appearance',
    'Keyboard',
    'Mirror',
    'Usage',
  ])
  // Each row shows its symbol on the right of its name.
  await expect(tabs(page).locator('[data-symbol]')).toHaveCount(7)
  await expect(tabs(page)).toHaveCSS('width', '155px')
  await expect(tabs(page)).toHaveAttribute('aria-orientation', 'vertical')
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true')
  // The selected row has a bar of the accent colour on its right edge.
  await expect(tab(page, 'General')).toHaveCSS('box-shadow', /-3px 0px 0px 0px inset/)
  await expect(tab(page, 'Editing')).toHaveCSS('box-shadow', 'none')
  // One pane at a time.
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('General')
  // The pane's region; its blocks are regions of their own inside it.
  await expect(page.getByRole('tabpanel').getByRole('region').first()).toHaveAccessibleName(
    'General',
  )
  await expect(page.getByRole('region', { name: 'General', exact: true })).toHaveCount(1)
})

test('a click on a row shows its pane', async ({ page }) => {
  await page.goto('/settings.html')
  await expect(page.getByRole('region', { name: 'General' })).toBeVisible()
  await tab(page, 'Editing').click()
  await expect(tab(page, 'Editing')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'false')
  await expect(editor(page)).toContainText('only on this Mac')
  await expect(page.getByRole('region', { name: 'General' })).toHaveCount(0)
  await tab(page, 'Preview').click()
  await expect(page.getByRole('region', { name: 'Preview' }).first()).toBeVisible()
})

test('the column is one tab stop; Up, Down, Home and End move between panes', async ({ page }) => {
  await page.goto('/settings.html')
  await expect(tab(page, 'General')).toHaveAttribute('tabindex', '0')
  await expect(tab(page, 'Editing')).toHaveAttribute('tabindex', '-1')
  await tab(page, 'General').focus()
  await page.keyboard.press('ArrowDown')
  await expect(tab(page, 'Editing')).toBeFocused()
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('End')
  await expect(tab(page, 'Usage')).toBeFocused()
  await expect(page.getByRole('region', { name: 'Usage Data' })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(tab(page, 'General')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(tab(page, 'Usage')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tab(page, 'General')).toBeFocused()
  // Tab leaves the column for the pane's first control (WebKit on macOS
  // tabs to buttons with Option, or with Full Keyboard Access).
  await page.keyboard.press('Alt+Tab')
  await expect(page.getByRole('combobox', { name: 'Default Notebook' })).toBeFocused()
})

test('opens on the pane shown last', async ({ page }) => {
  await page.goto('/settings.html')
  await tab(page, 'Mirror').click()
  await expect(page.getByRole('region', { name: 'Markdown Mirror' }).first()).toBeVisible()
  await page.reload()
  await expect(tab(page, 'Mirror')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Markdown Mirror' }).first()).toBeVisible()
  await expect(page.getByRole('region', { name: 'General' })).toHaveCount(0)
})

test('General opens the data folder and the Backups dialog', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { settings_open_data_folder: null, settings_show_backups: null }
  })
  await page.goto('/settings.html')
  const general = page.getByRole('region', { name: 'General' })
  const openFolder = general.getByRole('button', { name: 'Open Data Folder' })
  await expect(openFolder).toHaveAccessibleDescription(/notes, attachments, backups/)
  await openFolder.click()
  await general.getByRole('button', { name: 'Show Backups\u2026' }).click()
  // The command takes no path: it opens the app's own folder only.
  expect(await calls(page, 'settings_open_data_folder')).toEqual([
    { cmd: 'settings_open_data_folder', args: {} },
  ])
  expect(await calls(page, 'settings_show_backups')).toHaveLength(1)
  await expect(general.getByRole('alert')).toHaveCount(0)
})

test('General says when the data folder cannot be opened', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { settings_open_data_folder: { error: 'E_DATA_FOLDER_OPEN_FAILED' } }
  })
  await page.goto('/settings.html')
  const general = page.getByRole('region', { name: 'General' })
  await general.getByRole('button', { name: 'Open Data Folder' }).click()
  await expect(general.getByRole('alert')).toContainText('E_DATA_FOLDER_OPEN_FAILED')
})

test('General offers the notebooks as the default for new notes', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & {
      localStorage: { setItem(k: string, v: string): void }
    }
    w.devotEditorSettings = { defaultNotebook: 'book-b' }
    w.localStorage.setItem(
      'devot.notebookChoices',
      JSON.stringify([
        { id: 'book-a', name: 'Work', depth: 0 },
        { id: 'book-b', name: 'Plans', depth: 1 },
      ]),
    )
  })
  await page.goto('/settings.html')
  const notebook = page.getByRole('combobox', { name: 'Default Notebook' })
  await expect(notebook).toHaveValue('book-b')
  await expect(notebook).toHaveAccessibleDescription(/when the view shown has no notebook/)
  await expect(notebook.getByRole('option')).toHaveText(['None', 'Work', '\u00a0\u00a0Plans'])
  await notebook.selectOption('Work')
  expect(await setCalls(page)).toEqual([{ defaultNotebook: 'book-a' }])
  await notebook.selectOption('None')
  expect((await setCalls(page)).at(-1)).toEqual({ defaultNotebook: null })
})

// The Editing section.

const editor = (page: Page) => page.getByRole('region', { name: 'Editing' })
const checkbox = (page: Page, name: string) => editor(page).getByRole('switch', { name })
const select = (page: Page, name: string) => editor(page).getByRole('combobox', { name })
const fontSize = (page: Page) => editor(page).getByRole('spinbutton', { name: 'Font Size' })

async function openEditor(page: Page, stored: Record<string, unknown> = {}) {
  await page.addInitScript((settings) => {
    const w = globalThis as unknown as TestWindow & { devotEditorSettings: unknown }
    w.devotEditorSettings = settings
    w.devotIpcMocks = { usage_list: [] }
  }, stored)
  await openSettings(page, 'Editing')
}

const setCalls = async (page: Page) =>
  (await calls(page, 'editor_settings_set')).map((c) => c.args['patch'])

test('the Editing pane has Interface, Markdown and Text Appearance sections', async ({ page }) => {
  await openEditor(page)
  await expect(editor(page).getByRole('heading', { level: 3 })).toHaveText([
    'Interface',
    'Markdown',
    'Text Appearance',
  ])
  await expect(editor(page).getByRole('heading', { level: 3 }).first()).toHaveCSS(
    'font-size',
    '17px',
  )
  await expect(editor(page).getByRole('heading', { level: 3 }).first()).toHaveCSS(
    'font-weight',
    '700',
  )
  // Each section has its symbol, and each setting a label and a description.
  await expect(editor(page).locator('h3 [data-symbol]')).toHaveCount(3)
  await expect(checkbox(page, 'Toolbar')).toHaveAccessibleDescription(
    'Whether the toolbar shows over selected text and above the current table row.',
  )
})

test('every editor setting has a labelled control showing its stored value', async ({ page }) => {
  await openEditor(page, {
    toolbar: false,
    lineNumbers: true,
    highlightActiveLine: true,
    lineWrapping: true,
    inlineImages: false,
    readableWidth: true,
    scrollPastEnd: false,
    cursorScrollMargin: 40,
    listMarker: '+',
    indentUnit: 'tab',
    tabWidth: 8,
    pasteUrl: 'autolink',
    spellCheck: false,
    fontSize: 15,
    fontFamily: 'menlo',
    fontWeight: '600',
    lineHeight: 1.8,
    showInvisibles: true,
    highlightTrailingWhitespace: true,
  })
  await expect(checkbox(page, 'Toolbar')).not.toBeChecked()
  await expect(checkbox(page, 'Line Numbers')).toBeChecked()
  await expect(checkbox(page, 'Highlight Active Line')).toBeChecked()
  await expect(checkbox(page, 'Line Wrapping')).toBeChecked()
  await expect(checkbox(page, 'Inline Image Widgets')).not.toBeChecked()
  await expect(checkbox(page, 'Readable Line Length')).toBeChecked()
  await expect(checkbox(page, 'Scroll Past End')).not.toBeChecked()
  await expect(editor(page).getByRole('spinbutton', { name: 'Cursor Scroll Margin' })).toHaveValue(
    '40',
  )
  await expect(select(page, 'Unordered List Bullet')).toHaveValue('+')
  await expect(select(page, 'Indent Unit')).toHaveValue('tab')
  await expect(select(page, 'Tab Size')).toHaveValue('8')
  await expect(select(page, 'Paste URL as Link')).toHaveValue('autolink')
  await expect(checkbox(page, 'Spellcheck')).not.toBeChecked()
  await expect(fontSize(page)).toHaveValue('15')
  await expect(select(page, 'Font Family')).toHaveValue('menlo')
  await expect(select(page, 'Font Weight')).toHaveValue('600')
  await expect(select(page, 'Line Height')).toHaveValue('1.8')
  await expect(checkbox(page, 'Show Invisible Characters')).toBeChecked()
  await expect(checkbox(page, 'Highlight Trailing Whitespace')).toBeChecked()
  // Option labels come from the catalog too.
  await expect(select(page, 'Font Family').getByRole('option')).toHaveText([
    'System',
    'SF Mono',
    'Menlo',
    'Monaco',
    'Courier New',
    'Installed Font',
    'Imported Font',
  ])
  await expect(select(page, 'Font Weight').getByRole('option')).toHaveText([
    'normal',
    '300',
    '400',
    '500',
    '600',
    '700',
  ])
  await expect(select(page, 'Indent Unit').getByRole('option')).toHaveText([
    '2 spaces',
    '4 spaces',
    'Tab',
  ])
  await expect(select(page, 'Unordered List Bullet').getByRole('option')).toHaveText([
    '*',
    '-',
    '+',
  ])
  await expect(select(page, 'Paste URL as Link').getByRole('option')).toHaveText([
    'Plain text',
    'Autolink <URL>',
    'Link [](URL)',
  ])
  await expect(select(page, 'Line Height').getByRole('option')).toHaveText([
    '1.2',
    '1.4',
    '1.5',
    '1.6',
    '1.8',
    '2.0',
  ])
  await expect(fontSize(page)).toHaveAccessibleDescription(
    /\u2318= and \u2318- change it from the editor/,
  )
})

test('the new defaults show for settings never set', async ({ page }) => {
  await openEditor(page)
  await expect(checkbox(page, 'Toolbar')).toBeChecked()
  await expect(checkbox(page, 'Scroll Past End')).toBeChecked()
  await expect(checkbox(page, 'Highlight Active Line')).not.toBeChecked()
  await expect(checkbox(page, 'Spellcheck')).toBeChecked()
  await expect(select(page, 'Unordered List Bullet')).toHaveValue('*')
  await expect(select(page, 'Indent Unit')).toHaveValue('spaces2')
  await expect(select(page, 'Tab Size')).toHaveValue('2')
  await expect(select(page, 'Line Height')).toHaveValue('1.5')
  await expect(select(page, 'Paste URL as Link')).toHaveValue('link')
  await expect(select(page, 'Font Weight')).toHaveValue('normal')
})

test('the font size description drops its keys when one of them is cleared', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotShortcutRevision = 1
    w.devotShortcutOverrides = { 'view.fontSmaller': [] }
  })
  await openEditor(page)
  await expect(fontSize(page)).toHaveAccessibleDescription(
    /The command palette changes it too: Increase, Decrease and Reset Font Size\./,
  )
})

test('each control stores its change at once', async ({ page }) => {
  await openEditor(page)
  await checkbox(page, 'Toolbar').uncheck()
  await checkbox(page, 'Line Numbers').check()
  await checkbox(page, 'Highlight Active Line').check()
  // Readable Line Length applies only to wrapped lines: set it first.
  await checkbox(page, 'Readable Line Length').check()
  await checkbox(page, 'Line Wrapping').uncheck()
  await checkbox(page, 'Inline Image Widgets').uncheck()
  await checkbox(page, 'Scroll Past End').uncheck()
  await checkbox(page, 'Spellcheck').uncheck()
  await checkbox(page, 'Show Invisible Characters').check()
  await checkbox(page, 'Highlight Trailing Whitespace').check()
  await select(page, 'Unordered List Bullet').selectOption('+')
  await select(page, 'Indent Unit').selectOption('4 spaces')
  await select(page, 'Tab Size').selectOption('4')
  await select(page, 'Paste URL as Link').selectOption('Autolink <URL>')
  await select(page, 'Font Family').selectOption('System')
  await select(page, 'Font Weight').selectOption('500')
  await select(page, 'Line Height').selectOption('1.6')
  await fontSize(page).fill('16')
  await expect
    .poll(() => setCalls(page))
    .toEqual([
      { toolbar: false },
      { lineNumbers: true },
      { highlightActiveLine: true },
      { readableWidth: true },
      { lineWrapping: false },
      { inlineImages: false },
      { scrollPastEnd: false },
      { spellCheck: false },
      { showInvisibles: true },
      { highlightTrailingWhitespace: true },
      { listMarker: '+' },
      { indentUnit: 'spaces4' },
      { tabWidth: 4 },
      { pasteUrl: 'autolink' },
      { fontFamily: 'system' },
      { fontWeight: '500' },
      { lineHeight: 1.6 },
      { fontSize: 16 },
    ])
  await expect(checkbox(page, 'Line Numbers')).toBeChecked()
  await expect(select(page, 'Unordered List Bullet')).toHaveValue('+')
})

test('the readable width setting is off limits while lines do not wrap, and says why', async ({
  page,
}) => {
  await openEditor(page, { readableWidth: true })
  const width = checkbox(page, 'Readable Line Length')
  await expect(width).toBeEnabled()
  await expect(editor(page)).not.toContainText('Applies only when lines wrap.')

  await checkbox(page, 'Line Wrapping').uncheck()
  await expect(width).toBeDisabled()
  // It still shows the stored value, which applies again once lines wrap.
  await expect(width).toBeChecked()
  await expect(width).toHaveAccessibleDescription('Applies only when lines wrap.')

  await changedElsewhere(page, { lineWrapping: true, readableWidth: true })
  await expect(width).toBeEnabled()
  await expect(width).toHaveAccessibleDescription(/Limits the width of the editor to 740 pixels/)
  expect(await setCalls(page)).toEqual([{ lineWrapping: false }])
})

/** How long the number fields wait for typing to pause, and a little more. */
const PAST_TYPING_PAUSE_MS = 600

test('a font size out of range is not stored, and leaving the field shows the stored one', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openEditor(page, { fontSize: 14 })
  await expect(fontSize(page)).toHaveValue('14')
  await expect(fontSize(page)).toHaveAttribute('min', '10')
  await expect(fontSize(page)).toHaveAttribute('max', '32')
  // Each value is left to sit past the typing pause.
  for (const typed of ['40', '9', '12.5']) {
    await fontSize(page).fill(typed)
    await page.waitForTimeout(PAST_TYPING_PAUSE_MS)
    await expect(fontSize(page)).toHaveValue(typed)
    expect(await setCalls(page)).toEqual([])
    expect(errors).toEqual([])
  }
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  // Leaving the field at once stores nothing either.
  await fontSize(page).fill('40')
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  await page.waitForTimeout(PAST_TYPING_PAUSE_MS)
  expect(await setCalls(page)).toEqual([])
  expect(errors).toEqual([])
})

/**
 * Types each value into the font size field in one go (no timer runs between
 * them, however slow the machine): a burst of keystrokes with no pause.
 */
const typeBurst = (page: Page, values: string[]) =>
  fontSize(page).evaluate((input, typed) => {
    const field = input as unknown as {
      value: string
      dispatchEvent(e: unknown): void
      focus(): void
    }
    const w = globalThis as unknown as {
      Event: new (type: string, init: { bubbles: boolean }) => unknown
      HTMLInputElement: { prototype: object }
    }
    const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set
    field.focus()
    for (const value of typed) {
      set?.call(field, value)
      field.dispatchEvent(new w.Event('input', { bubbles: true }))
    }
  }, values)

test('the font size is stored once typing pauses, or when the field is left', async ({ page }) => {
  await openEditor(page)
  await typeBurst(page, ['12', '14'])
  await expect.poll(() => setCalls(page)).toEqual([{ fontSize: 14 }])
  await typeBurst(page, ['16'])
  await fontSize(page).blur()
  expect(await setCalls(page)).toEqual([{ fontSize: 14 }, { fontSize: 16 }])
  await expect(fontSize(page)).toHaveValue('16')
  await page.waitForTimeout(600)
  expect(await setCalls(page)).toHaveLength(2)
})

test('a change made in another window shows at once', async ({ page }) => {
  await openEditor(page)
  await expect(fontSize(page)).toHaveValue('13')
  await changedElsewhere(page, { fontSize: 18, lineNumbers: true })
  await expect(fontSize(page)).toHaveValue('18')
  await expect(checkbox(page, 'Line Numbers')).toBeChecked()
})

test('a change that cannot be stored is reported and undone', async ({ page }) => {
  await openEditor(page)
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      editor_settings_set: { error: 'E_EDITOR_SETTINGS_WRITE_FAILED' },
    }
  })
  // Clicked, not checked: the box is checked only until the store refuses.
  await checkbox(page, 'Line Numbers').click()
  await expect(editor(page).getByRole('alert')).toHaveText(
    'The editor settings could not be saved (E_EDITOR_SETTINGS_WRITE_FAILED).',
  )
  await expect(checkbox(page, 'Line Numbers')).not.toBeChecked()
})

// The Preview pane.

const preview = (page: Page) => page.getByRole('region', { name: 'Preview' })

test('Preview has its own font size (15 px) and synced scrolling', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & { devotEditorSettings: unknown }
    w.devotIpcMocks = { usage_list: [] }
  })
  await openSettings(page, 'Preview')
  const size = preview(page).getByRole('spinbutton', { name: 'Font Size' })
  const sync = preview(page).getByRole('switch', { name: 'Synced Scrolling' })
  await expect(size).toHaveValue('15')
  await expect(sync).toBeChecked()
  await sync.uncheck()
  await size.fill('18')
  await size.blur()
  await expect.poll(() => setCalls(page)).toEqual([{ syncScroll: false }, { previewFontSize: 18 }])
  // The editor pane no longer has the synced scrolling switch.
  await tab(page, 'Editing').click()
  await expect(editor(page).getByRole('switch', { name: 'Synced Scrolling' })).toHaveCount(0)
})
