import type { Page } from '@playwright/test'
import { expect, openApp, test, type TestWindow } from './fixtures'
import { pickPluginMenu, pluginFrame, servePlugins, testPlugin } from './plugins'

// Contract tests for each contribution point (ADR 0005): commands, menu items, keymaps, preview renderers, import and export
// formats, and a plugin's panel, each through the protocol and only with its permission. Rust is faked in the page.

const body = (page: Page) => page.getByRole('textbox', { name: 'Note body' })
const noteRows = (page: Page) => page.getByRole('listbox', { name: 'Notes' }).getByRole('option')
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command Palette' })

const savedNotes = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('devot.test.notes') ?? '[]') as {
        title: string
        bodyMd: string
      }[],
  )

const calls = (page: Page, cmd: string) =>
  page.evaluate(
    (c) =>
      (globalThis as unknown as TestWindow).devotIpcCalls
        .filter((call) => call.cmd === c)
        .map((call) => call.args),
    cmd,
  )

const TOOLS = `
devot.commands.handle('upper', async () => {
  const note = await devot.note.read()
  await devot.note.replace({ base: note.markdown, markdown: note.markdown.toUpperCase() })
})
devot.commands.handle('taken', () => {
  globalThis.takenRan = true
})
devot.commands.handle('panel', async () => {
  document.body.textContent = 'Panel of tools'
  await devot.ui.show({ height: 200 })
})
devot.ui.onHidden(() => {
  globalThis.hidden = (globalThis.hidden ?? 0) + 1
})
devot.preview.handle('shout', (source) => '**' + source.toUpperCase() + '** <script>top.shouted = 1</script><img src=x onerror="top.shouted = 2">')
devot.importer.handle('shout', ({ name, text }) => {
  if (name.includes('bad')) throw new Error('no')
  return { title: name.replace(/\\.shout$/, ''), markdown: text.toUpperCase() }
})
devot.exporter.handle('shout', ({ title, markdown }) => title + ': ' + markdown.toUpperCase())
`

const tools = testPlugin(
  'com.example.tools',
  ['note.read', 'note.edit', 'commands', 'menus', 'keymaps', 'preview', 'import', 'export'],
  {
    commands: [
      { id: 'upper', title: 'Upper Case' },
      { id: 'taken', title: 'Taken Key' },
      { id: 'panel', title: 'Open Tools Panel' },
    ],
    menus: [{ command: 'upper' }],
    keymaps: [
      { command: 'upper', key: 'Mod+Ctrl+Shift+J' },
      { command: 'taken', key: 'Mod+N' },
    ],
    previewRenderers: [{ id: 'shout', language: 'shout' }],
    importFormats: [{ id: 'shout', title: 'Shout Files', extensions: ['shout'] }],
    exportFormats: [{ id: 'shout', title: 'Shout', extension: 'shout' }],
  },
  TOOLS,
)

const denied = testPlugin(
  'com.example.denied',
  ['commands', 'preview'],
  {
    commands: [{ id: 'nope', title: 'Never Listed' }],
    previewRenderers: [{ id: 'q', language: 'quiet' }],
  },
  "devot.commands.handle('nope', () => null); devot.preview.handle('q', () => 'drawn')",
  { granted: [] },
)

const off = testPlugin(
  'com.example.off',
  ['commands'],
  { commands: [{ id: 'x', title: 'Turned Off' }] },
  "devot.commands.handle('x', () => null)",
  { enabled: false },
)

async function noteWith(page: Page, text: string) {
  await page.getByRole('button', { name: 'New Note', exact: true }).click()
  await expect(noteRows(page)).toHaveCount(1)
  await body(page).click()
  await page.keyboard.insertText(text)
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toBe(text)
}

async function paletteRun(page: Page, label: string) {
  await page.keyboard.press('Meta+KeyK')
  await palette(page).getByRole('combobox', { name: 'Command Palette' }).fill(`> ${label}`)
  await palette(page)
    .getByRole('option', { name: new RegExp(label) })
    .first()
    .click()
}

test.beforeEach(async ({ page }) => {
  await servePlugins(page, [tools, denied, off])
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      plugin_import_pick: () => [
        { name: 'first.shout', text: 'quiet one' },
        { name: 'second.shout', text: 'quiet two' },
      ],
      plugin_export_save: () => true,
    }
  })
  await openApp(page)
  await pluginFrame(page, 'com.example.tools')
})

test('lists the commands of enabled plugins with what was granted, under the plugin name', async ({
  page,
}) => {
  await noteWith(page, 'x')
  await page.keyboard.press('Meta+KeyK')
  await palette(page).getByRole('combobox', { name: 'Command Palette' }).fill('> ')
  const commands = palette(page).getByRole('option')
  await expect(commands.filter({ hasText: 'Upper Case' })).toContainText('Plugin tools')
  await expect(commands.filter({ hasText: 'Import Shout Files…' })).toHaveCount(1)
  await expect(commands.filter({ hasText: 'Export Note as Shout…' })).toHaveCount(1)
  await expect(commands.filter({ hasText: 'Never Listed' })).toHaveCount(0)
  await expect(commands.filter({ hasText: 'Turned Off' })).toHaveCount(0)
})

test('a command reads and replaces the open note, as one step Undo takes back', async ({
  page,
}) => {
  await noteWith(page, 'hello world')
  await paletteRun(page, 'Upper Case')
  await expect(body(page)).toHaveText('HELLO WORLD')
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toBe('HELLO WORLD')
  await body(page).click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(body(page)).toHaveText('hello world')
})

test('a keymap runs its command; a key the app uses stays the app’s', async ({ page }) => {
  await noteWith(page, 'keyed')
  await page.keyboard.press('Meta+Control+Shift+KeyJ')
  await expect(body(page)).toHaveText('KEYED')
  const frame = await pluginFrame(page, 'com.example.tools')
  await page.keyboard.press('Meta+KeyN')
  await expect(noteRows(page)).toHaveCount(2)
  expect(
    await frame.evaluate(() => (globalThis as { takenRan?: boolean }).takenRan),
  ).toBeUndefined()
})

test('a menu item picked in the menu bar runs its command', async ({ page }) => {
  await noteWith(page, 'menu')
  await pickPluginMenu(page, { kind: 'command', plugin: 'com.example.tools', id: 'upper' })
  await expect(body(page)).toHaveText('MENU')
})

test('a preview renderer draws its language as sanitized Markdown, and only with its permission', async ({
  page,
}) => {
  await noteWith(page, '```shout\nhi there\n```\n\n```quiet\nleft as code\n```\n')
  await page.keyboard.press('Meta+KeyE')
  const preview = page.locator('.preview')
  const block = preview.locator('.plugin-block[data-plugin="com.example.tools/shout"]')
  await expect(block.locator('strong')).toHaveText('HI THERE')
  await expect(block.locator('script')).toHaveCount(0)
  await expect(block.locator('img[onerror]')).toHaveCount(0)
  await expect(preview.getByText('left as code')).toBeVisible()
  expect(await page.evaluate(() => (globalThis as { shouted?: number }).shouted)).toBeUndefined()
})

test('an import format turns the picked files into notes', async ({ page }) => {
  await paletteRun(page, 'Import Shout Files')
  await expect(noteRows(page)).toHaveCount(2)
  const notes = await savedNotes(page)
  expect(notes.map((n) => [n.title, n.bodyMd]).sort()).toEqual([
    ['first', 'QUIET ONE'],
    ['second', 'QUIET TWO'],
  ])
  expect(await calls(page, 'plugin_import_pick')).toEqual([
    { plugin: 'com.example.tools', format: 'shout' },
  ])
})

test('an export format turns the open note into a file Rust saves', async ({ page }) => {
  await noteWith(page, 'export me')
  await page.getByRole('textbox', { name: 'Title' }).fill('Plan')
  await expect.poll(async () => (await savedNotes(page))[0]?.title).toBe('Plan')
  await paletteRun(page, 'Export Note as Shout')
  await expect
    .poll(() => calls(page, 'plugin_export_save'))
    .toEqual([
      { plugin: 'com.example.tools', format: 'shout', title: 'Plan', text: 'Plan: EXPORT ME' },
    ])
})

test('a plugin shows its panel while its command runs; Close hides it and tells the plugin', async ({
  page,
}) => {
  await noteWith(page, 'x')
  await paletteRun(page, 'Open Tools Panel')
  const panel = page.getByRole('dialog', { name: 'Plugin tools' })
  await expect(panel).toBeVisible()
  const frame = panel.locator('iframe.plugin-frame[data-plugin="com.example.tools"]')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveCSS('height', '200px')
  const inner = await pluginFrame(page, 'com.example.tools')
  expect(await inner.evaluate(() => document.body.textContent)).toBe('Panel of tools')
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toBeHidden()
  await expect.poll(() => inner.evaluate(() => (globalThis as { hidden?: number }).hidden)).toBe(1)
})

test('an import that fails partway keeps the notes it made, tries the rest and shows them', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      plugin_import_pick: () => [
        { name: 'first.shout', text: 'quiet one' },
        { name: 'bad.shout', text: 'quiet bad' },
        { name: 'second.shout', text: 'quiet two' },
      ],
    }
  })
  await paletteRun(page, 'Import Shout Files')
  await expect(noteRows(page)).toHaveCount(2)
  const notes = await savedNotes(page)
  expect(notes.map((n) => [n.title, n.bodyMd]).sort()).toEqual([
    ['first', 'QUIET ONE'],
    ['second', 'QUIET TWO'],
  ])
  await expect(page.getByRole('alert')).toContainText('E_PLUGIN_FAILED')
})

test('a read-only licence keeps plugin imports and edits from changing notes', async ({ page }) => {
  await noteWith(page, 'hello world')
  // The trial is over and no licence is added, as Rust tells the window.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('devot:licence-changed', {
        detail: {
          gated: true,
          state: 'none',
          code: null,
          id: null,
          licensee: null,
          plan: null,
          trial: { state: 'ended', endsAt: Date.now() - 3_600_000, code: null },
        },
      }),
    )
  })
  await page.keyboard.press('Meta+KeyK')
  await palette(page).getByRole('combobox', { name: 'Command Palette' }).fill('> ')
  const entries = palette(page).getByRole('option')
  await expect(entries.filter({ hasText: 'Upper Case' })).toHaveCount(1)
  await expect(entries.filter({ hasText: 'Import Shout Files…' })).toHaveCount(0)
  await expect(entries.filter({ hasText: 'Export Note as Shout…' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toBeHidden()

  // A command is not hidden, but its edit is refused; an import that still arrives (a menu item Rust has not disabled) is too.
  await pickPluginMenu(page, { kind: 'command', plugin: 'com.example.tools', id: 'upper' })
  const notice = page.locator('[data-devot-plugin-notice]')
  await expect(notice).toContainText('Your Devot trial has ended, so a plugin cannot change notes.')
  await expect(notice.getByRole('button', { name: 'Add License' })).toBeVisible()
  await expect(body(page)).toHaveText('hello world')
  await expect.poll(async () => (await savedNotes(page))[0]?.bodyMd).toBe('hello world')
})

test('a failing plugin shows a notice with its code, never its text', async ({ page }) => {
  await noteWith(page, 'x')
  const frame = await pluginFrame(page, 'com.example.tools')
  await frame.evaluate(() => {
    const g = globalThis as unknown as {
      devot: { commands: { handle(id: string, fn: () => never): void } }
    }
    g.devot.commands.handle('upper', () => {
      throw new Error('note text in an error')
    })
  })
  await paletteRun(page, 'Upper Case')
  await expect(page.locator('[data-devot-plugin-notice]')).toHaveText(
    /Plugin tools could not finish \(E_PLUGIN_FAILED\)\./,
  )
})
