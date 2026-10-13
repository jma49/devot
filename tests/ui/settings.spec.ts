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

// The Editor section.

const editor = (page: Page) => page.getByRole('region', { name: 'Editor' })
const checkbox = (page: Page, name: string) => editor(page).getByRole('checkbox', { name })
const select = (page: Page, name: string) => editor(page).getByRole('combobox', { name })
const fontSize = (page: Page) => editor(page).getByRole('spinbutton', { name: 'Font size' })

async function openEditor(page: Page, stored: Record<string, unknown> = {}) {
  await page.addInitScript((settings) => {
    const w = globalThis as unknown as TestWindow & { devotEditorSettings: unknown }
    w.devotEditorSettings = settings
    w.devotIpcMocks = { usage_list: [] }
  }, stored)
  await openSettings(page, 'Editor')
}

const setCalls = async (page: Page) =>
  (await calls(page, 'editor_settings_set')).map((c) => c.args['patch'])

/** What Rust sends every window after a change made elsewhere. */
const changedElsewhere = changeEditorSettingsElsewhere

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Settings panes' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })

test('the window title is the only Settings title; a toolbar tab per pane, General first', async ({
  page,
}) => {
  await page.goto('/settings.html')
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
  await expect(tabs(page).getByRole('tab')).toHaveText([
    'General',
    'Editor',
    'Appearance',
    'Keyboard',
    'Markdown Mirror',
    'Usage',
  ])
  // Each tab shows its symbol.
  await expect(tabs(page).locator('[data-symbol]')).toHaveCount(6)
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true')
  // One pane at a time.
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('General')
  await expect(page.getByRole('region')).toHaveCount(1)
  await expect(page.getByRole('region')).toHaveAccessibleName('General')
  // The window fits the pane it opens on, at once.
  const fits = await calls(page, 'settings_fit')
  expect(fits.length).toBeGreaterThan(0)
  expect(fits[0]?.args['animate']).toBe(false)
  expect(fits[0]?.args['height']).toBeGreaterThan(0)
})

test('a click on a tab shows its pane, and the window fits it, animated', async ({ page }) => {
  await page.goto('/settings.html')
  await expect(page.getByRole('region', { name: 'General' })).toBeVisible()
  const before = (await calls(page, 'settings_fit')).length
  await tab(page, 'Editor').click()
  await expect(tab(page, 'Editor')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'false')
  await expect(editor(page)).toContainText('only on this Mac')
  await expect(page.getByRole('region', { name: 'General' })).toHaveCount(0)
  await expect.poll(async () => (await calls(page, 'settings_fit')).length).toBeGreaterThan(before)
  const last = (await calls(page, 'settings_fit')).at(-1)
  expect(last?.args['animate']).toBe(true)
})

test('the toolbar is one tab stop; the arrow keys, Home and End move between panes', async ({
  page,
}) => {
  await page.goto('/settings.html')
  await expect(tab(page, 'General')).toHaveAttribute('tabindex', '0')
  await expect(tab(page, 'Editor')).toHaveAttribute('tabindex', '-1')
  await tab(page, 'General').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Editor')).toBeFocused()
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('End')
  await expect(tab(page, 'Usage')).toBeFocused()
  await expect(page.getByRole('region', { name: 'Usage Data' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'General')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(tab(page, 'Usage')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tab(page, 'General')).toBeFocused()
  // Tab leaves the toolbar for the pane's first control (WebKit on macOS
  // tabs to buttons with Option, or with Full Keyboard Access).
  await page.keyboard.press('Alt+Tab')
  await expect(page.getByRole('button', { name: 'Open Data Folder' })).toBeFocused()
})

test('opens on the pane shown last', async ({ page }) => {
  await page.goto('/settings.html')
  await tab(page, 'Markdown Mirror').click()
  await expect(page.getByRole('region', { name: 'Markdown Mirror' })).toBeVisible()
  await page.reload()
  await expect(tab(page, 'Markdown Mirror')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: 'Markdown Mirror' })).toBeVisible()
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

test('every editor setting has a labelled control showing its stored value', async ({ page }) => {
  await openEditor(page, {
    lineNumbers: false,
    readableWidth: true,
    fontSize: 15,
    fontFamily: 'menlo',
    lineHeight: 1.8,
    indentUnit: 'tab',
    tabWidth: 8,
    listMarker: '*',
    spellCheck: true,
    pasteUrl: 'link',
    syncScroll: false,
    inlineImages: false,
  })
  await expect(checkbox(page, 'Show line numbers')).not.toBeChecked()
  await expect(checkbox(page, 'Scroll the editor and preview together')).not.toBeChecked()
  await expect(checkbox(page, 'Show images under their lines')).not.toBeChecked()
  await expect(checkbox(page, 'Wrap lines')).toBeChecked()
  await expect(checkbox(page, 'Limit lines to a readable width')).toBeChecked()
  await expect(checkbox(page, 'Highlight the current line')).toBeChecked()
  await expect(checkbox(page, 'Check spelling while typing')).toBeChecked()
  await expect(fontSize(page)).toHaveValue('15')
  await expect(select(page, 'Font')).toHaveValue('menlo')
  await expect(select(page, 'Line height')).toHaveValue('1.8')
  await expect(select(page, 'Indent with')).toHaveValue('tab')
  await expect(select(page, 'Tab width')).toHaveValue('8')
  await expect(select(page, 'List marker')).toHaveValue('*')
  await expect(select(page, 'Paste a URL as')).toHaveValue('link')
  await expect(select(page, 'Paste a URL as')).toHaveAccessibleDescription(
    'A URL pasted over selected text always makes a link.',
  )
  // Option labels come from the catalog too.
  await expect(select(page, 'Font').getByRole('option')).toHaveText([
    'System',
    'SF Mono',
    'Menlo',
    'Monaco',
    'Courier New',
  ])
  await expect(select(page, 'Indent with').getByRole('option')).toHaveText([
    '2 spaces',
    '4 spaces',
    'Tabs',
  ])
  await expect(select(page, 'List marker').getByRole('option')).toHaveText([
    'Hyphen (-)',
    'Asterisk (*)',
  ])
  await expect(select(page, 'Paste a URL as').getByRole('option')).toHaveText([
    'Plain text',
    'Autolink <URL>',
    'Link [](URL)',
  ])
  await expect(select(page, 'Line height').getByRole('option')).toHaveText([
    '1.2',
    '1.4',
    '1.6',
    '1.8',
    '2.0',
  ])
  await expect(editor(page)).toContainText('\u2318= and \u2318- change it from the editor')
})

test('the font size hint drops its keys when one of them is cleared', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotShortcutRevision = 1
    w.devotShortcutOverrides = { 'view.fontSmaller': [] }
  })
  await openEditor(page)
  await expect(fontSize(page)).toHaveAccessibleDescription(
    'The command palette changes it too: Increase, Decrease and Reset Font Size.',
  )
})

test('each control stores its change at once', async ({ page }) => {
  await openEditor(page)
  await checkbox(page, 'Show line numbers').check()
  await checkbox(page, 'Limit lines to a readable width').check()
  await checkbox(page, 'Wrap lines').uncheck()
  await checkbox(page, 'Highlight the current line').uncheck()
  await checkbox(page, 'Scroll the editor and preview together').uncheck()
  await checkbox(page, 'Show images under their lines').uncheck()
  await checkbox(page, 'Check spelling while typing').check()
  await select(page, 'Font').selectOption('System')
  await select(page, 'Line height').selectOption('1.6')
  await select(page, 'Indent with').selectOption('4 spaces')
  await select(page, 'Tab width').selectOption('2')
  await select(page, 'List marker').selectOption('Asterisk (*)')
  await select(page, 'Paste a URL as').selectOption('Autolink <URL>')
  await fontSize(page).fill('16')
  await expect
    .poll(() => setCalls(page))
    .toEqual([
      { lineNumbers: true },
      { readableWidth: true },
      { lineWrapping: false },
      { highlightActiveLine: false },
      { syncScroll: false },
      { inlineImages: false },
      { spellCheck: true },
      { fontFamily: 'system' },
      { lineHeight: 1.6 },
      { indentUnit: 'spaces4' },
      { tabWidth: 2 },
      { listMarker: '*' },
      { pasteUrl: 'autolink' },
      { fontSize: 16 },
    ])
  await expect(checkbox(page, 'Show line numbers')).toBeChecked()
  await expect(select(page, 'List marker')).toHaveValue('*')
})

test('the readable width setting is off limits while lines do not wrap, and says why', async ({
  page,
}) => {
  await openEditor(page, { readableWidth: true })
  const width = checkbox(page, 'Limit lines to a readable width')
  await expect(width).toBeEnabled()
  await expect(editor(page)).not.toContainText('Applies only when lines wrap.')

  await checkbox(page, 'Wrap lines').uncheck()
  await expect(width).toBeDisabled()
  // It still shows the stored value, which applies again once lines wrap.
  await expect(width).toBeChecked()
  await expect(width).toHaveAccessibleDescription('Applies only when lines wrap.')

  await changedElsewhere(page, { lineWrapping: true, readableWidth: true })
  await expect(width).toBeEnabled()
  await expect(width).toHaveAccessibleDescription('')
  expect(await setCalls(page)).toEqual([{ lineWrapping: false }])
})

/** How long EditorSection waits for typing to pause, and a little more. */
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
  await changedElsewhere(page, { fontSize: 18, lineNumbers: false })
  await expect(fontSize(page)).toHaveValue('18')
  await expect(checkbox(page, 'Show line numbers')).not.toBeChecked()
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
  // Clicked, not unchecked: the box is unchecked only until the store refuses.
  await checkbox(page, 'Show line numbers').click()
  await expect(editor(page).getByRole('alert')).toHaveText(
    'The editor settings could not be saved (E_EDITOR_SETTINGS_WRITE_FAILED).',
  )
  await expect(checkbox(page, 'Show line numbers')).not.toBeChecked()
})
