import type { Page } from '@playwright/test'
import {
  changeEditorSettingsElsewhere,
  expect,
  openSettings,
  test,
  type TestWindow,
} from './fixtures'

const AT = Date.UTC(2026, 9, 10, 9, 30)

// usage_list returns newest first.
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
  await changeEditorSettingsElsewhere(page, { sidebarMaterial: false })
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

const changedElsewhere = changeEditorSettingsElsewhere

const tabs = (page: Page) => page.getByRole('tablist', { name: 'Settings panes' })
const tab = (page: Page, name: string) => tabs(page).getByRole('tab', { name, exact: true })

test('a navigation column of panes on the left, General first', async ({ page }) => {
  await page.goto('/settings.html')
  await expect(page.getByRole('heading', { name: 'Settings' })).toHaveCount(0)
  await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible()
  await expect(tabs(page).getByRole('tab')).toHaveText([
    'General',
    'Appearance',
    'Editing',
    'Preview',
    'Keyboard',
    'Mirror',
    'Sync',
    'AI',
    'Integrations',
    'Plugins',
    'Usage',
    'License',
  ])
  await expect(tabs(page).getByRole('tab').locator('[data-symbol]')).toHaveCount(12)
  await expect(tabs(page)).toHaveCSS('width', '200px')
  await expect(tabs(page)).toHaveAttribute('aria-orientation', 'vertical')
  await expect(tab(page, 'General')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('General')
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
  await expect(tab(page, 'Appearance')).toHaveAttribute('tabindex', '-1')
  await tab(page, 'General').focus()
  await page.keyboard.press('ArrowDown')
  await expect(tab(page, 'Appearance')).toBeFocused()
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeVisible()
  await page.keyboard.press('End')
  await expect(tab(page, 'License')).toBeFocused()
  await expect(page.getByRole('region', { name: 'License' }).first()).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(tab(page, 'General')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(tab(page, 'License')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(tab(page, 'General')).toBeFocused()
  // Tab leaves the column for the pane's first control (WebKit on macOS tabs to buttons only with Option or Full Keyboard Access).
  await page.keyboard.press('Alt+Tab')
  // The toolbar comes between the column and the pane: Back takes the focus first.
  await expect(page.locator('.settings-history-button').first()).toBeFocused()
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
  // The command takes no path: it only opens the app's own folder.
  expect(await calls(page, 'settings_open_data_folder')).toEqual([
    { cmd: 'settings_open_data_folder', args: {} },
  ])
  expect(await calls(page, 'settings_show_backups')).toHaveLength(1)
  await expect(general.getByRole('alert')).toHaveCount(0)
})

const BRIDGE = '/Applications/My Apps/Devot.app/Contents/MacOS/devot'
const CODEX_PREVIEW = `[mcp_servers.devot]\ncommand = "${BRIDGE}"\nargs = ["--cli", "mcp"]\n`

function clientStatus(client: string, path: string, state: string, extra: object = {}) {
  return {
    client,
    path,
    backup: `${path}.devot-backup`,
    state,
    code: null,
    missing: false,
    preview: `the entry for ${client}`,
    revision: 'missing',
    via: 'file',
    ...extra,
  }
}

function setupWith(states: { claudeCode?: string; codex?: string; claudeDesktop?: string } = {}) {
  return {
    command: BRIDGE,
    args: ['--cli', 'mcp'],
    temporary: false,
    clients: [
      clientStatus('claudeCode', '/Users/me/.claude.json', states.claudeCode ?? 'notConnected'),
      clientStatus('codex', '/Users/me/.codex/config.toml', states.codex ?? 'notConnected', {
        preview: CODEX_PREVIEW,
      }),
      clientStatus(
        'claudeDesktop',
        '/Users/me/Library/Application Support/Claude/claude_desktop_config.json',
        states.claudeDesktop ?? 'notConnected',
      ),
    ],
  }
}

test('Integrations offers configs to copy that run this app as the bridge', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { settings_mcp_setup: setup }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const claude = page.getByRole('region', { name: 'Claude Code' })
  const command = `claude mcp add --scope user devot -- '${BRIDGE}' --cli mcp`
  await expect(claude.locator('code')).toHaveText(command)
  await expect(page.getByRole('region', { name: 'Codex' }).locator('code').first()).toHaveText(
    CODEX_PREVIEW.trimEnd(),
  )
  await expect(page.getByRole('region', { name: 'Other MCP Clients' })).toContainText(
    '"mcpServers"',
  )
  await expect(page.getByRole('tabpanel')).not.toContainText(/\bnode\b/i)
  // Each card follows the one before at the block spacing: nothing sits between them.
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  const next = await aiTools.evaluate((el) => {
    const block = el.closest('.settings-block') ?? el
    return block.nextElementSibling?.classList.contains('settings-block') ?? false
  })
  expect(next).toBe(true)

  await claude.getByRole('button', { name: 'Copy the Claude Code configuration' }).click()
  await expect(page.getByRole('tabpanel').getByRole('status').last()).toHaveText(
    'The Claude Code configuration was copied.',
  )
  expect(await calls(page, 'clipboard_write_text')).toEqual([
    { cmd: 'clipboard_write_text', args: { text: command } },
  ])
  // StrictMode runs the effect twice in dev.
  const setups = await calls(page, 'settings_mcp_setup')
  expect(setups.length).toBeGreaterThan(0)
  for (const call of setups) expect(call).toEqual({ cmd: 'settings_mcp_setup', args: {} })
})

test('Connect shows what it will write and where, and writes only once confirmed', async ({
  page,
}) => {
  await page.addInitScript(
    ({ setup, connected }) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_mcp_connect: connected,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    {
      setup: setupWith(),
      connected: clientStatus('codex', '/Users/me/.codex/config.toml', 'connected', {
        preview: CODEX_PREVIEW,
      }),
    },
  )
  await openSettings(page, 'Integrations')
  const codex = page.getByRole('region', { name: 'Codex' })
  await expect(codex).toContainText('Not connected.')
  await codex.getByRole('button', { name: 'Connect Codex' }).click()

  const dialog = page.getByRole('dialog', { name: 'Connect Codex?' })
  await expect(dialog).toContainText('/Users/me/.codex/config.toml.devot-backup')
  await expect(dialog.locator('code')).toHaveText(CODEX_PREVIEW)
  await expect(dialog).toContainText('If Codex is running it may rewrite this file at any time')
  await expect(dialog).toContainText('This turns on Allow AI Tools.')
  await expect(dialog).toContainText('Devot may start in the background with no window')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(await calls(page, 'settings_mcp_connect')).toEqual([])

  await codex.getByRole('button', { name: 'Connect Codex' }).click()
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(codex).toContainText('Connected through /Users/me/.codex/config.toml.')
  await expect(page.getByRole('tabpanel').getByRole('status').last()).toHaveText(
    'Codex is connected. Restart it if it is running.',
  )
  expect(await calls(page, 'settings_mcp_connect')).toEqual([
    { cmd: 'settings_mcp_connect', args: { client: 'codex', revision: 'missing' } },
  ])
  await expect(codex.getByRole('button', { name: 'Disconnect Codex' })).toBeVisible()
})

test('Claude Code is changed through its own CLI when there is one, and the dialog says so', async ({
  page,
}) => {
  const command = `/opt/homebrew/bin/claude mcp add --scope user devot -- '${BRIDGE}' --cli mcp`
  await page.addInitScript(
    (setup) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    {
      ...setupWith(),
      clients: [
        clientStatus('claudeCode', '/Users/me/.claude.json', 'notConnected', {
          via: 'claudeCli',
          preview: command,
        }),
      ],
    },
  )
  await openSettings(page, 'Integrations')
  await page
    .getByRole('region', { name: 'Claude Code' })
    .getByRole('button', { name: 'Connect Claude Code' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Connect Claude Code?' })
  await expect(dialog.locator('code')).toHaveText(command)
  await expect(dialog).toContainText('Claude Code can stay open')
  await expect(dialog).not.toContainText('quit it first')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

test('Disconnect names the file, removes only on confirming and reports a refusal', async ({
  page,
}) => {
  await page.addInitScript(
    (setup) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_mcp_disconnect: { error: 'E_MCP_CONFIG_CHANGED' },
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    setupWith({ claudeCode: 'connected' }),
  )
  await openSettings(page, 'Integrations')
  const claude = page.getByRole('region', { name: 'Claude Code' })
  await claude.getByRole('button', { name: 'Disconnect Claude Code' }).click()
  const dialog = page.getByRole('dialog', { name: 'Disconnect Claude Code?' })
  await expect(dialog).toContainText('removes only its devot entry from /Users/me/.claude.json')
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveText(
    'The client’s configuration was not changed (E_MCP_CONFIG_CHANGED).',
  )
  await expect(claude).toContainText('Connected through')
  // It shows the file as it is now before another try.
  await expect.poll(async () => (await calls(page, 'settings_mcp_setup')).length).toBeGreaterThan(1)
})

test('A moved app, a foreign entry and an unreadable file each say what to do', async ({
  page,
}) => {
  await page.addInitScript(
    (setup) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    {
      ...setupWith(),
      clients: [
        clientStatus('claudeCode', '/Users/me/.claude.json', 'stale'),
        clientStatus('codex', '/Users/me/.codex/config.toml', 'other'),
        clientStatus('claudeDesktop', '/x/claude_desktop_config.json', 'unreadable', {
          code: 'E_MCP_CONFIG_UNPARSABLE',
        }),
      ],
    },
  )
  await openSettings(page, 'Integrations')
  const claude = page.getByRole('region', { name: 'Claude Code' })
  await expect(claude).toContainText('points at a copy of Devot that has moved')
  await expect(claude.getByRole('button', { name: 'Reconnect Claude Code' })).toBeEnabled()
  const codex = page.getByRole('region', { name: 'Codex' })
  await expect(codex.getByRole('button', { name: 'Replace Codex' })).toBeEnabled()
  const desktop = page.getByRole('region', { name: 'Claude Desktop' })
  await expect(desktop).toContainText(
    'could not be read or changed safely (E_MCP_CONFIG_UNPARSABLE)',
  )
  await expect(desktop.getByRole('button', { name: 'Connect Claude Desktop' })).toHaveCount(0)
  await expect(
    desktop.getByRole('button', { name: 'Copy the Claude Desktop configuration' }),
  ).toBeEnabled()
})

test('Connect waits until Devot is installed, while configs stay available', async ({ page }) => {
  await page.addInitScript(
    (setup) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    { ...setupWith(), temporary: true },
  )
  await openSettings(page, 'Integrations')
  await expect(page.getByRole('tabpanel')).toContainText('Move it to Applications')
  const desktop = page.getByRole('region', { name: 'Claude Desktop' })
  await expect(desktop.getByRole('button', { name: 'Connect Claude Desktop' })).toBeDisabled()
  await expect(desktop.getByRole('button', { name: 'Install as Extension' })).toBeDisabled()
  await expect(
    desktop.getByRole('button', { name: 'Copy the Claude Desktop configuration' }),
  ).toBeEnabled()
})

test('Install as Extension opens the bundle, and says when it cannot', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_mcp_open_extension: { error: 'E_MCP_EXTENSION_OPEN_FAILED' },
      settings_ai_access_summary: { notebooks: 3, allowed: 1 },
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const desktop = page.getByRole('region', { name: 'Claude Desktop' })
  await desktop.getByRole('button', { name: 'Install as Extension' }).click()
  await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText(
    'E_MCP_EXTENSION_OPEN_FAILED',
  )
  expect(await calls(page, 'settings_mcp_open_extension')).toHaveLength(1)
})

test('Connecting with no notebook allowed leads on to choosing one', async ({ page }) => {
  await page.addInitScript(
    ({ setup, connected }) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_mcp_connect: connected,
        settings_ai_access_summary: { notebooks: 3, allowed: 0 },
      }
    },
    {
      setup: setupWith(),
      connected: clientStatus('codex', '/Users/me/.codex/config.toml', 'connected'),
    },
  )
  await openSettings(page, 'Integrations')
  await page.getByRole('dialog').getByRole('button', { name: 'Later' }).click()
  const codex = page.getByRole('region', { name: 'Codex' })
  await codex.getByRole('button', { name: 'Connect Codex' }).click()
  await page
    .getByRole('dialog', { name: 'Connect Codex?' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click()
  await expect(page.getByRole('dialog', { name: 'No notebook allows AI access' })).toBeVisible()
})

test('Integrations still offers configs, with the installed path, when Rust cannot say', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { settings_mcp_setup: { error: 'E_DATA_FOLDER_UNAVAILABLE' } }
  })
  await openSettings(page, 'Integrations')
  const pane = page.getByRole('tabpanel')
  // The sentence reads as a sentence: it says what could not be found, with the code in brackets (A159).
  await expect(pane.getByRole('alert')).toHaveText(
    'Devot could not read the client configurations (E_DATA_FOLDER_UNAVAILABLE).',
  )
  const claude = page.getByRole('region', { name: 'Claude Code' })
  await expect(claude.locator('code')).toContainText('/Applications/Devot.app/Contents/MacOS/devot')
  await claude.getByRole('button', { name: 'Copy the Claude Code configuration' }).click()
  await expect(pane.getByRole('status').last()).toHaveText(
    'The Claude Code configuration was copied.',
  )
})

type McpAccessMock = {
  enabled: boolean
  scope: string
  backgroundStart: boolean
  reachable: boolean
  problem: string | null
}

const ACCESS: McpAccessMock = {
  enabled: true,
  scope: 'readWrite',
  backgroundStart: true,
  reachable: true,
  problem: null,
}

async function openAiTools(page: Page, access: McpAccessMock, mode: string) {
  await page.addInitScript(
    ({ setup, access, mode }) => {
      const w = globalThis as unknown as TestWindow
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
        mcp_access_get: access,
        background_state: { mode },
        mcp_access_set: (args: unknown) => ({ ...access, ...(args as object) }),
        background_quit: null,
      }
    },
    { setup: setupWith(), access, mode },
  )
  await openSettings(page, 'Integrations')
  return page.getByRole('region', { name: 'AI Tools' })
}

test('AI Tools says plainly, before any Connect, that Devot may start in the background', async ({
  page,
}) => {
  const section = await openAiTools(page, ACCESS, 'normal')
  const start = section.getByRole('switch', { name: 'Start in the Background' })
  await expect(start).toBeChecked()
  await expect(start).toHaveAccessibleDescription(/Devot starts in the background with no window/)
  await expect(start).toHaveAccessibleDescription(/Quit Devot/)
  await expect(start).toHaveAccessibleDescription(/after 10 minutes/)
  await expect(start).toHaveAccessibleDescription(/next request starts it again while this is on/)
  await expect(section).toContainText('Devot is open as usual.')
  const before = await section.boundingBox()
  const client = await page.getByRole('region', { name: 'Claude Code' }).boundingBox()
  expect(before!.y).toBeLessThan(client!.y)
})

test('AI Tools shows when Devot runs in the background, and Quit Devot asks Rust to quit', async ({
  page,
}) => {
  const section = await openAiTools(page, ACCESS, 'background')
  await expect(section).toContainText('Devot is running in the background for AI tools.')
  await section.getByRole('button', { name: 'Quit Devot' }).click()
  expect(await calls(page, 'background_quit')).toEqual([{ cmd: 'background_quit', args: {} }])
  await expect(section.getByRole('alert')).toHaveCount(0)
})

test('AI Tools turns background starts off and chooses read-only, keeping the other choices', async ({
  page,
}) => {
  const section = await openAiTools(page, ACCESS, 'normal')
  await section.getByRole('switch', { name: 'Start in the Background' }).click()
  await expect.poll(() => calls(page, 'mcp_access_set')).toHaveLength(1)
  expect((await calls(page, 'mcp_access_set'))[0]!.args).toEqual({
    enabled: true,
    scope: 'readWrite',
    backgroundStart: false,
  })
  await section.getByRole('combobox', { name: 'Access' }).selectOption('read')
  await expect.poll(() => calls(page, 'mcp_access_set')).toHaveLength(2)
  expect((await calls(page, 'mcp_access_set'))[1]!.args).toEqual({
    enabled: true,
    scope: 'read',
    backgroundStart: false,
  })
})

test('AI Tools says why tools cannot reach Devot, with the code', async ({ page }) => {
  const section = await openAiTools(
    page,
    { ...ACCESS, reachable: false, problem: 'E_HTTP_API_PORT_IN_USE' },
    'normal',
  )
  await expect(section.getByRole('alert')).toHaveText(
    'AI tools cannot reach Devot now (E_HTTP_API_PORT_IN_USE).',
  )
})

test('A failure to quit or to save says so with its code', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      mcp_access_set: { error: 'E_MCP_ACCESS_WRITE_FAILED' },
      background_quit: { error: 'E_BACKGROUND_WINDOW' },
    }
  })
  await openSettings(page, 'Integrations')
  const section = page.getByRole('region', { name: 'AI Tools' })
  await section.getByRole('switch', { name: 'Allow AI Tools' }).click()
  await expect(section.getByRole('alert')).toHaveText(
    'The AI Tools settings could not be changed (E_MCP_ACCESS_WRITE_FAILED).',
  )
  await section.getByRole('button', { name: 'Quit Devot' }).click()
  await expect(section.getByRole('alert')).toHaveText('Devot could not quit (E_BACKGROUND_WINDOW).')
})

test('General installs and removes the devot command, showing whether it is there', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    const path = '/usr/local/bin/devot'
    w.devotIpcMocks = {
      cli_tool_install: { state: 'installed', path },
      cli_tool_uninstall: { state: 'absent', path },
    }
  })
  await page.goto('/settings.html')
  const row = page.getByRole('region', { name: 'Command Line' })
  const install = row.getByRole('button', { name: 'Install' })
  await expect(install).toHaveAccessibleDescription(
    /^Adds the devot command at \/usr\/local\/bin\/devot/,
  )
  await install.click()
  const uninstall = row.getByRole('button', { name: 'Uninstall' })
  await expect(uninstall).toHaveAccessibleDescription(/^Installed at \/usr\/local\/bin\/devot\./)
  await uninstall.click()
  await expect(install).toBeEnabled()
  // The commands take no arguments: the link and its target are the app's own.
  expect(await calls(page, 'cli_tool_install')).toEqual([{ cmd: 'cli_tool_install', args: {} }])
  expect(await calls(page, 'cli_tool_uninstall')).toEqual([{ cmd: 'cli_tool_uninstall', args: {} }])
  await expect(page.getByRole('region', { name: 'General' }).getByRole('alert')).toHaveCount(0)
})

test('General says when the devot command cannot be installed', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      cli_tool_status: { state: 'other', path: '/usr/local/bin/devot' },
      cli_tool_install: { error: 'E_CLI_PATH_TAKEN' },
    }
  })
  await page.goto('/settings.html')
  const general = page.getByRole('region', { name: 'General' })
  const install = general.getByRole('button', { name: 'Install' })
  await expect(install).toHaveAccessibleDescription(
    /^Something else is at \/usr\/local\/bin\/devot/,
  )
  await install.click()
  await expect(general.getByRole('alert')).toContainText('E_CLI_PATH_TAKEN')
  await expect(install).toBeEnabled()
})

test('General offers no devot command in a build without one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = { cli_tool_status: { state: 'unavailable', path: '/usr/local/bin/devot' } }
  })
  await page.goto('/settings.html')
  const install = page.getByRole('region', { name: 'General' }).getByRole('button', {
    name: 'Install',
  })
  await expect(install).toBeDisabled()
  await expect(install).toHaveAccessibleDescription('This build of Devot has no command line tool.')
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

const editor = (page: Page) => page.getByRole('region', { name: 'Editing' })
const checkbox = (page: Page, name: string) => editor(page).getByRole('switch', { name })
const select = (page: Page, name: string) => editor(page).getByRole('combobox', { name })
const appearance = (page: Page) => page.getByRole('tabpanel', { name: 'Appearance' })
const fontSize = (page: Page) =>
  appearance(page).getByRole('spinbutton', { name: 'Editor Font Size' })

async function openAppearance(page: Page, stored: Record<string, unknown> = {}) {
  await page.addInitScript((settings) => {
    const w = globalThis as unknown as TestWindow & { devotEditorSettings: unknown }
    w.devotEditorSettings = settings
    w.devotIpcMocks = { usage_list: [] }
  }, stored)
  await openSettings(page, 'Appearance')
}

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

test('the Editing pane has Interface, Markdown, Text Appearance and font sections', async ({
  page,
}) => {
  await openEditor(page)
  await expect(editor(page).getByRole('heading', { level: 3 })).toHaveText([
    'Interface',
    'Markdown',
    'Text Appearance',
    'App Font',
    'Code Font',
  ])
  await expect(editor(page).getByRole('heading', { level: 3 }).first()).toHaveCSS(
    'font-size',
    '13px',
  )
  await expect(editor(page).getByRole('heading', { level: 3 }).first()).toHaveCSS(
    'font-weight',
    '600',
  )
  await expect(checkbox(page, 'Toolbar')).toHaveAccessibleDescription(
    'Whether the toolbar shows over selected text and above the current table row.',
  )
})

test('every editor setting has a labelled control showing its stored value', async ({ page }) => {
  await openEditor(page, {
    toolbar: false,
    lineNumbers: true,
    highlightActiveLine: true,
    lineWrapping: 'prose',
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
  await expect(select(page, 'Line Wrapping')).toHaveValue('prose')
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
  await expect(select(page, 'Font Weight')).toHaveValue('600')
  await expect(select(page, 'Line Height')).toHaveValue('1.8')
  await expect(checkbox(page, 'Show Invisible Characters')).toBeChecked()
  await expect(checkbox(page, 'Highlight Trailing Whitespace')).toBeChecked()
  await expect(select(page, 'Line Wrapping').getByRole('option')).toHaveText([
    'Off',
    'All lines',
    'Prose only',
    'Unwrap at cursor',
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
    'Choose each time',
  ])
  await expect(select(page, 'Line Height').getByRole('option')).toHaveText([
    '1.2',
    '1.4',
    '1.5',
    '1.6',
    '1.8',
    '2.0',
  ])
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
  await openAppearance(page)
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
  await select(page, 'Line Wrapping').selectOption('Off')
  await checkbox(page, 'Inline Image Widgets').uncheck()
  await checkbox(page, 'Scroll Past End').uncheck()
  await checkbox(page, 'Spellcheck').uncheck()
  await checkbox(page, 'Show Invisible Characters').check()
  await checkbox(page, 'Highlight Trailing Whitespace').check()
  await select(page, 'Unordered List Bullet').selectOption('+')
  await select(page, 'Indent Unit').selectOption('4 spaces')
  await select(page, 'Tab Size').selectOption('4')
  await select(page, 'Paste URL as Link').selectOption('Autolink <URL>')
  await select(page, 'Font Weight').selectOption('500')
  await select(page, 'Line Height').selectOption('1.6')
  await expect
    .poll(() => setCalls(page))
    .toEqual([
      { toolbar: false },
      { lineNumbers: true },
      { highlightActiveLine: true },
      { readableWidth: true },
      { lineWrapping: 'off' },
      { inlineImages: false },
      { scrollPastEnd: false },
      { spellCheck: false },
      { showInvisibles: true },
      { highlightTrailingWhitespace: true },
      { listMarker: '+' },
      { indentUnit: 'spaces4' },
      { tabWidth: 4 },
      { pasteUrl: 'autolink' },
      { fontWeight: '500' },
      { lineHeight: 1.6 },
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

  await select(page, 'Line Wrapping').selectOption('Off')
  await expect(width).toBeDisabled()
  // It still shows the stored value, which applies again once lines wrap.
  await expect(width).toBeChecked()
  await expect(width).toHaveAccessibleDescription('Applies only when lines wrap.')

  await changedElsewhere(page, { lineWrapping: 'all', readableWidth: true })
  await expect(width).toBeEnabled()
  await expect(width).toHaveAccessibleDescription(/Limits the width of the editor to 740 pixels/)
  expect(await setCalls(page)).toEqual([{ lineWrapping: 'off' }])
})

/** The number fields' typing pause plus margin. */
const PAST_TYPING_PAUSE_MS = 600

test('a font size out of range is not stored, and leaving the field shows the stored one', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openAppearance(page, { fontSize: 14 })
  await expect(fontSize(page)).toHaveValue('14')
  await expect(fontSize(page)).toHaveAttribute('min', '10')
  await expect(fontSize(page)).toHaveAttribute('max', '32')
  for (const typed of ['40', '9', '12.5']) {
    await fontSize(page).fill(typed)
    await page.waitForTimeout(PAST_TYPING_PAUSE_MS)
    await expect(fontSize(page)).toHaveValue(typed)
    expect(await setCalls(page)).toEqual([])
    expect(errors).toEqual([])
  }
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  await fontSize(page).fill('40')
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  await page.waitForTimeout(PAST_TYPING_PAUSE_MS)
  expect(await setCalls(page)).toEqual([])
  expect(errors).toEqual([])
})

/** Types each value in one go with no timer between keystrokes, however slow the machine. */
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
  await openAppearance(page)
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
  await openAppearance(page)
  await expect(fontSize(page)).toHaveValue('13')
  await changedElsewhere(page, { fontSize: 18, lineNumbers: true })
  await expect(fontSize(page)).toHaveValue('18')
  await tab(page, 'Editing').click()
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

const preview = (page: Page) => page.getByRole('region', { name: 'Preview' })

test('Preview has synced scrolling; its font size sits in Appearance', async ({ page }) => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as TestWindow & { devotEditorSettings: unknown }
    w.devotIpcMocks = { usage_list: [] }
  })
  await openSettings(page, 'Preview')
  const sync = preview(page).getByRole('switch', { name: 'Synced Scrolling' })
  await expect(sync).toBeChecked()
  await sync.uncheck()
  await expect.poll(() => setCalls(page)).toEqual([{ syncScroll: false }])
  await expect(preview(page).getByRole('spinbutton')).toHaveCount(0)
  await tab(page, 'Editing').click()
  await expect(editor(page).getByRole('switch', { name: 'Synced Scrolling' })).toHaveCount(0)
})

test('Integrations says when no notebook allows AI access and offers the picker', async ({
  page,
}) => {
  await page.addInitScript((setup) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: { notebooks: 3, allowed: 0 },
      main_window_show: null,
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const prompt = page.getByRole('dialog', { name: 'No notebook allows AI access' })
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('Right-click a notebook in the sidebar')
  await prompt.getByRole('button', { name: 'Choose Notebooks\u2026' }).click()
  await expect(prompt).toHaveCount(0)
  expect(await calls(page, 'main_window_show')).toEqual([{ cmd: 'main_window_show', args: {} }])
  // The main window reads this flag when it gains focus.
  expect(await page.evaluate(() => localStorage.getItem('devot:choose-ai-access'))).toBe('1')
})

test('Later keeps the AI access prompt quiet for the Settings window', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: { notebooks: 2, allowed: 0 },
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const prompt = page.getByRole('dialog', { name: 'No notebook allows AI access' })
  await prompt.getByRole('button', { name: 'Later' }).click()
  await expect(prompt).toHaveCount(0)
  await tab(page, 'General').click()
  await tab(page, 'Integrations').click()
  await expect(prompt).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).toContainText('0 of 2 notebooks allow AI access.')
})

test('Integrations offers a way to create a notebook when there is none', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = globalThis as unknown as TestWindow
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: { notebooks: 0, allowed: 0 },
      main_window_show: null,
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const prompt = page.getByRole('dialog', { name: 'No notebook allows AI access' })
  await expect(prompt).toContainText('Devot has no notebooks yet')
  await prompt.getByRole('button', { name: 'Open Devot' }).click()
  expect(await calls(page, 'main_window_show')).toEqual([{ cmd: 'main_window_show', args: {} }])
})

test('search finds a setting and shows its pane', async ({ page }) => {
  await page.goto('/settings.html')
  const field = page.getByRole('searchbox', { name: 'Search Settings' })
  await field.fill('transparency')
  const results = page.getByRole('listbox', { name: 'Search Results' })
  await expect(results.getByRole('option')).toContainText(['Transparency'])
  await field.press('Enter')
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeVisible()
  await expect(field).toHaveValue('')
})

test('Back and Forward walk the panes visited', async ({ page }) => {
  await page.goto('/settings.html')
  const back = page.locator('.settings-history-button').first()
  const forward = page.locator('.settings-history-button').last()
  await expect(back).toBeDisabled()
  await expect(forward).toBeDisabled()
  await tab(page, 'Appearance').click()
  await tab(page, 'Editing').click()
  await expect(back).toBeEnabled()
  await back.click()
  await expect(page.getByRole('tabpanel', { name: 'Appearance' })).toBeVisible()
  await expect(forward).toBeEnabled()
  await forward.click()
  await expect(page.getByRole('tabpanel', { name: 'Editing' })).toBeVisible()
})

test('the search capsule lines up with the rows, and every control ends on the card padding', async ({
  page,
}) => {
  await openSettings(page, 'Appearance')
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!
  const search = await box('.settings-search')
  const selected = await box('.settings-nav-row[aria-selected="true"]')
  expect([search.x, search.x + search.width]).toEqual([selected.x, selected.x + selected.width])
  await expect(page.locator('.settings-search')).toHaveCSS('border-radius', '14px')

  for (const pane of ['General', 'Appearance', 'Editing']) {
    await tab(page, pane).click()
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('.settings-card')].flatMap((card) => {
        const right =
          card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight)
        return [...card.querySelectorAll('.setting-control > *')]
          .map((control) => control.getBoundingClientRect().right - right)
          .filter((by) => Math.abs(by) > 0.5)
      }),
    )
    expect(overflow).toEqual([])
  }
})

test('the selected pane turns a lighter grey, not a colour, while the window is behind another', async ({
  page,
}) => {
  await page.goto('/settings.html')
  const row = page.locator('.settings-nav-row[aria-selected="true"]')
  const token = (name: string) =>
    page.evaluate((n) => {
      const probe = document.body.appendChild(document.createElement('div'))
      probe.style.backgroundColor = `var(${n})`
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }, name)
  await expect(row).toHaveCSS('background-color', await token('--color-fill-row-selected'))
  await page.locator('main.settings').evaluate((el) => el.removeAttribute('data-focused'))
  await expect(row).toHaveCSS('background-color', await token('--color-fill-row-selected-inactive'))
})

test('crash reports stay off until chosen', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { devotIpcMocks?: Record<string, unknown> }
    w.devotIpcMocks = {
      crash_reports_get: { available: true, on: false },
      crash_reports_set: { available: true, on: true },
    }
  })
  await page.goto('/settings.html')
  const toggle = page.getByRole('switch', { name: 'Send Crash Reports' })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  expect(await calls(page, 'crash_reports_set')).toHaveLength(1)
})

test('a build that can send no crash reports does not offer them', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { devotIpcMocks?: Record<string, unknown> }
    w.devotIpcMocks = { crash_reports_get: { available: false, on: false } }
  })
  await page.goto('/settings.html')
  await expect(page.getByRole('switch', { name: 'Send Crash Reports' })).toHaveCount(0)
})
