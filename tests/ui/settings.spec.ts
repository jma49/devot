import type { Page } from '@playwright/test'
import { sizes } from '../../src/renderer/src/theme/tokens'
import { changeEditorSettingsElsewhere, expect, openSettings, test } from './fixtures'

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

async function open(page: Page, events: unknown[] | { error: string }) {
  await page.addInitScript((stored) => {
    const w = window
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
  page.evaluate((c) => window.devotIpcCalls.filter((call) => call.cmd === c), cmd)

test('a failed clear stays reported after the window reloads', async ({ page }) => {
  await open(page, EVENTS)
  await page.evaluate(() => {
    const w = window
    w.devotIpcMocks = { ...w.devotIpcMocks, usage_clear: { error: 'E_USAGE_STORE_FAILED' } }
  })
  await section(page).getByRole('button', { name: 'Clear Usage Data\u2026' }).click()
  await page
    .getByRole('dialog', { name: 'Clear all usage data?' })
    .getByRole('button', { name: 'Clear', exact: true })
    .click()
  const alert = section(page).getByRole('alert')
  await expect(alert).toHaveText('The usage data could not be cleared.')
  await page.evaluate(() => window.dispatchEvent(new window.Event('focus')))
  await expect(alert).toBeVisible()
  await expect(section(page)).toContainText('4 events are stored on this Mac.')
})

test('reloads the events when the window comes back to the front', async ({ page }) => {
  await open(page, [])
  await expect(section(page)).toContainText('No usage events are stored.')
  await page.evaluate(
    (events) => {
      const w = window
      w.devotIpcMocks = { usage_list: events }
      w.dispatchEvent(new window.Event('focus'))
    },
    EVENTS.slice(0, 1),
  )
  await expect(section(page)).toContainText('1 event is stored on this Mac.')
})

test('shows why the events could not be read', async ({ page }) => {
  await open(page, { error: 'E_USAGE_OPEN_FAILED' })
  await expect(section(page).getByRole('alert')).toHaveText('The usage data could not be read.')
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
    const w = window
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

/** The configurations to copy, under Set Up by Hand at the end of the Clients card. */
async function byHand(page: Page) {
  const clients = page.getByRole('region', { name: 'Clients' })
  const toggle = clients.getByRole('button', { name: 'Set Up by Hand' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  return clients
}
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
    const w = window
    w.devotIpcMocks = { settings_mcp_setup: setup }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const clients = page.getByRole('region', { name: 'Clients' })
  const toggle = clients.getByRole('button', { name: 'Set Up by Hand' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(clients.locator('code')).toHaveCount(0)
  await toggle.click()
  const command = `claude mcp add --scope user devot -- '${BRIDGE}' --cli mcp`
  const codes = clients.locator('code')
  await expect(codes).toHaveCount(4)
  await expect(codes.nth(0)).toHaveText(command)
  await expect(codes.nth(1)).toHaveText(CODEX_PREVIEW.trimEnd())
  await expect(codes.nth(3)).toContainText('"mcpServers"')
  await expect(clients).toContainText('Other MCP Clients')
  await expect(page.getByRole('tabpanel')).not.toContainText(/\bnode\b/i)
  // Each card follows the one before at the block spacing: nothing sits between them.
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  const next = await aiTools.evaluate((el) => {
    const block = el.closest('.settings-block') ?? el
    return block.nextElementSibling?.classList.contains('settings-block') ?? false
  })
  expect(next).toBe(true)

  await clients.getByRole('button', { name: 'Copy the Claude Code configuration' }).click()
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

test('Clients has one row per client with its state, and only the buttons that state offers', async ({
  page,
}) => {
  await page.addInitScript(
    (setup) => {
      const w = window
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    setupWith({ codex: 'connected' }),
  )
  await openSettings(page, 'Integrations')
  await expect(page.getByRole('region', { name: 'Claude Code' })).toHaveCount(0)
  const claude = page.getByRole('group', { name: 'Claude Code' })
  await expect(claude).toContainText('Not connected')
  await expect(claude.getByRole('button')).toHaveText(['Connect'])
  await expect(claude.getByRole('button', { name: 'Connect Claude Code' })).toHaveClass(
    /button-default/,
  )
  const codex = page.getByRole('group', { name: 'Codex' })
  await expect(codex).toContainText('Connected')
  await expect(codex.getByRole('button')).toHaveText(['Disconnect'])
  const desktop = page.getByRole('group', { name: 'Claude Desktop' })
  await expect(desktop.getByRole('button')).toHaveText(['Install Extension', 'Connect'])
  // The primary button keeps its accent in a settings card, so it never looks disabled.
  const fill = (name: string) =>
    desktop
      .getByRole('button', { name })
      .evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color])
  const [primaryFill, primaryText] = await fill('Connect Claude Desktop')
  const [plainFill] = await fill('Install Extension')
  expect(primaryFill).not.toBe(plainFill)
  expect(primaryText).not.toBe(primaryFill)
  await expect(codex.locator('.client-state-dot')).toHaveAttribute('data-state', 'connected')
})

test('Connect shows what it will write and where, and writes only once confirmed', async ({
  page,
}) => {
  await page.addInitScript(
    ({ setup, connected }) => {
      const w = window
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
  const codex = page.getByRole('group', { name: 'Codex' })
  await expect(codex).toContainText('Not connected')
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
  await expect(codex).toContainText('Connected')
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
      const w = window
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
    .getByRole('group', { name: 'Claude Code' })
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
      const w = window
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_mcp_disconnect: { error: 'E_MCP_CONFIG_CHANGED' },
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    setupWith({ claudeCode: 'connected' }),
  )
  await openSettings(page, 'Integrations')
  const claude = page.getByRole('group', { name: 'Claude Code' })
  await claude.getByRole('button', { name: 'Disconnect Claude Code' }).click()
  const dialog = page.getByRole('dialog', { name: 'Disconnect Claude Code?' })
  await expect(dialog).toContainText('removes only its devot entry from /Users/me/.claude.json')
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('tabpanel').getByRole('alert')).toHaveText(
    'The client’s configuration was not changed.',
  )
  await expect(claude).toContainText('Connected')
  // It shows the file as it is now before another try.
  await expect.poll(async () => (await calls(page, 'settings_mcp_setup')).length).toBeGreaterThan(1)
})

test('A moved app, a foreign entry and an unreadable file each say what to do', async ({
  page,
}) => {
  await page.addInitScript(
    (setup) => {
      const w = window
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
  const claude = page.getByRole('group', { name: 'Claude Code' })
  await expect(claude).toContainText('Points at a copy of Devot that has moved')
  await expect(claude.getByRole('button', { name: 'Reconnect Claude Code' })).toBeEnabled()
  const codex = page.getByRole('group', { name: 'Codex' })
  await expect(codex.getByRole('button', { name: 'Replace Codex' })).toBeEnabled()
  const desktop = page.getByRole('group', { name: 'Claude Desktop' })
  await expect(desktop).toContainText('Its file cannot be changed safely')
  await expect(desktop.getByRole('button', { name: 'Connect Claude Desktop' })).toHaveCount(0)
  await expect(
    (await byHand(page)).getByRole('button', { name: 'Copy the Claude Desktop configuration' }),
  ).toBeEnabled()
})

test('Connect waits until Devot is installed, while configs stay available', async ({ page }) => {
  await page.addInitScript(
    (setup) => {
      const w = window
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
      }
    },
    { ...setupWith(), temporary: true },
  )
  await openSettings(page, 'Integrations')
  await expect(page.getByRole('tabpanel')).toContainText('Move it to Applications')
  const desktop = page.getByRole('group', { name: 'Claude Desktop' })
  await expect(desktop.getByRole('button', { name: 'Connect Claude Desktop' })).toBeDisabled()
  await expect(desktop.getByRole('button', { name: 'Install Extension' })).toBeDisabled()
  await expect(
    (await byHand(page)).getByRole('button', { name: 'Copy the Claude Desktop configuration' }),
  ).toBeEnabled()
})

test('Install Extension opens the bundle, and says when it cannot', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = window
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_mcp_open_extension: { error: 'E_MCP_EXTENSION_OPEN_FAILED' },
      settings_ai_access_summary: { notebooks: 3, allowed: 1 },
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const desktop = page.getByRole('group', { name: 'Claude Desktop' })
  await desktop.getByRole('button', { name: 'Install Extension' }).click()
  await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText(
    'The extension could not be opened.',
  )
  expect(await calls(page, 'settings_mcp_open_extension')).toHaveLength(1)
})

test('Connecting with no notebook allowed opens nothing more, and the notice stays', async ({
  page,
}) => {
  await page.addInitScript(
    ({ setup, connected }) => {
      const w = window
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
  const codex = page.getByRole('group', { name: 'Codex' })
  await codex.getByRole('button', { name: 'Connect Codex' }).click()
  await page
    .getByRole('dialog', { name: 'Connect Codex?' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'AI Tools' }).locator('.settings-footnote').first(),
  ).toContainText('No notebook allows AI access yet')
})

test('Integrations still offers configs, with the installed path, when Rust cannot say', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = { settings_mcp_setup: { error: 'E_DATA_FOLDER_UNAVAILABLE' } }
  })
  await openSettings(page, 'Integrations')
  const pane = page.getByRole('tabpanel')
  // The sentence reads as a sentence: it says what could not be read, and the code stays in the log (A159).
  await expect(pane.getByRole('alert')).toHaveText(
    'Devot could not read the client configurations.',
  )
  const clients = await byHand(page)
  await expect(clients.locator('code').first()).toContainText(
    '/Applications/Devot.app/Contents/MacOS/devot',
  )
  await clients.getByRole('button', { name: 'Copy the Claude Code configuration' }).click()
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
    ({ setup, access: granted, mode: background }) => {
      const w = window
      w.devotIpcMocks = {
        settings_mcp_setup: setup,
        settings_ai_access_summary: { notebooks: 3, allowed: 1 },
        mcp_access_get: granted,
        background_state: { mode: background },
        mcp_access_set: (args: unknown) => ({ ...granted, ...(args as object) }),
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
  const aiTools = await openAiTools(page, ACCESS, 'normal')
  const start = aiTools.getByRole('switch', { name: 'Start in the Background' })
  await expect(start).toBeChecked()
  await expect(start).toHaveAccessibleDescription(
    'When an AI tool asks and Devot is closed, Devot opens without a window. Quit it from the menu bar at any time.',
  )
  await expect(aiTools.locator('.settings-footnote')).toHaveText(
    'A Devot started in the background quits by itself after 10 minutes without a request. With Start in the Background off, AI tools get an error until you open Devot.',
  )
  const rows = aiTools.locator('.setting-label')
  await expect(rows).toHaveText([
    'Allow AI Tools',
    'Notebooks',
    'Access',
    'Start in the Background',
    'Status',
  ])
  await expect(aiTools).toContainText('1 of 3 notebooks allow AI access.')
  await expect(aiTools).toContainText('Open as usual.')
  await expect(aiTools.getByRole('button', { name: 'Quit Devot' })).toHaveCount(0)
  const before = await aiTools.boundingBox()
  const client = await page.getByRole('region', { name: 'Clients' }).boundingBox()
  expect(before!.y).toBeLessThan(client!.y)
})

test('Notebooks in AI Tools opens the notebook picker in the main window', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = { main_window_show: null }
  })
  await openSettings(page, 'Integrations')
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  await expect(aiTools).toContainText('1 of 1 notebooks allow AI access.')
  await aiTools.getByRole('button', { name: 'Choose\u2026' }).click()
  expect(await calls(page, 'main_window_show')).toEqual([{ cmd: 'main_window_show', args: {} }])
  expect(await page.evaluate(() => localStorage.getItem('devot:choose-ai-access'))).toBe('1')
})

test('AI Tools shows when Devot runs in the background, and Quit Devot asks Rust to quit', async ({
  page,
}) => {
  const aiTools = await openAiTools(page, ACCESS, 'background')
  await expect(aiTools).toContainText('Running in the background for AI tools.')
  await aiTools.getByRole('button', { name: 'Quit Devot' }).click()
  expect(await calls(page, 'background_quit')).toEqual([{ cmd: 'background_quit', args: {} }])
  await expect(aiTools.getByRole('alert')).toHaveCount(0)
})

test('AI Tools turns background starts off and chooses read-only, keeping the other choices', async ({
  page,
}) => {
  const aiTools = await openAiTools(page, ACCESS, 'normal')
  await aiTools.getByRole('switch', { name: 'Start in the Background' }).click()
  await expect.poll(() => calls(page, 'mcp_access_set')).toHaveLength(1)
  expect((await calls(page, 'mcp_access_set'))[0]!.args).toEqual({
    enabled: true,
    scope: 'readWrite',
    backgroundStart: false,
  })
  await aiTools.getByRole('combobox', { name: 'Access' }).selectOption('read')
  await expect.poll(() => calls(page, 'mcp_access_set')).toHaveLength(2)
  expect((await calls(page, 'mcp_access_set'))[1]!.args).toEqual({
    enabled: true,
    scope: 'read',
    backgroundStart: false,
  })
})

test('AI Tools says why tools cannot reach Devot, with the code', async ({ page }) => {
  const aiTools = await openAiTools(
    page,
    { ...ACCESS, reachable: false, problem: 'E_HTTP_API_PORT_IN_USE' },
    'normal',
  )
  await expect(aiTools.getByRole('alert')).toHaveText('AI tools cannot reach Devot now.')
})

test('A keychain that waits is said calmly, with what to do and the code', async ({ page }) => {
  const aiTools = await openAiTools(
    page,
    { ...ACCESS, reachable: false, problem: 'E_MCP_KEYCHAIN_WAITING' },
    'normal',
  )
  await expect(aiTools.getByRole('alert')).toHaveCount(0)
  await expect(aiTools.getByRole('status')).toHaveText(
    'macOS is asking whether Devot may use its keychain item. Choose Allow in that dialog, and AI tools can reach Devot.',
  )
})

test('A failure to quit or to save says so with its code', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
    w.devotIpcMocks = {
      mcp_access_set: { error: 'E_MCP_ACCESS_WRITE_FAILED' },
      background_quit: { error: 'E_BACKGROUND_WINDOW' },
      background_state: { mode: 'background' },
    }
  })
  await openSettings(page, 'Integrations')
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  await aiTools.getByRole('switch', { name: 'Allow AI Tools' }).click()
  await expect(aiTools.getByRole('alert')).toHaveText('The AI Tools settings could not be changed.')
  await aiTools.getByRole('button', { name: 'Quit Devot' }).click()
  await expect(aiTools.getByRole('alert')).toHaveText('Devot could not quit.')
})

test('General installs and removes the devot command, showing whether it is there', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window
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
    const w = window
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
  await expect(general.getByRole('alert')).toHaveText('The command line tool could not be changed.')
  await expect(install).toBeEnabled()
})

test('General offers no devot command in a build without one', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
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
    const w = window
    w.devotIpcMocks = { settings_open_data_folder: { error: 'E_DATA_FOLDER_OPEN_FAILED' } }
  })
  await page.goto('/settings.html')
  const general = page.getByRole('region', { name: 'General' })
  await general.getByRole('button', { name: 'Open Data Folder' }).click()
  await expect(general.getByRole('alert')).toHaveText('The data folder could not be opened.')
})

test('General offers the notebooks as the default for new notes', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
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
    const w = window
    w.devotEditorSettings = settings
    w.devotIpcMocks = { usage_list: [] }
  }, stored)
  await openSettings(page, 'Appearance')
}

async function openEditor(page: Page, stored: Record<string, unknown> = {}) {
  await page.addInitScript((settings) => {
    const w = window
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
    showCounts: false,
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
    const w = window
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
  await checkbox(page, 'Word and Character Counts').uncheck()
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
      { showCounts: false },
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
  await page.clock.install()
  for (const typed of ['40', '9', '12.5']) {
    await fontSize(page).fill(typed)
    await page.clock.runFor(PAST_TYPING_PAUSE_MS)
    await expect(fontSize(page)).toHaveValue(typed)
    expect(await setCalls(page)).toEqual([])
    expect(errors).toEqual([])
  }
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  await fontSize(page).fill('40')
  await fontSize(page).blur()
  await expect(fontSize(page)).toHaveValue('14')
  await page.clock.runFor(PAST_TYPING_PAUSE_MS)
  expect(await setCalls(page)).toEqual([])
  expect(errors).toEqual([])
})

/** Types each value in one go with no timer between keystrokes, however slow the machine. */
const typeBurst = (page: Page, values: string[]) =>
  fontSize(page).evaluate((input, typed) => {
    const field = input
    const w = window
    const set = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set
    field.focus()
    for (const value of typed) {
      set?.call(field, value)
      field.dispatchEvent(new w.Event('input', { bubbles: true }))
    }
  }, values)

test('the font size is stored once typing pauses, or when the field is left', async ({ page }) => {
  await openAppearance(page)
  await page.clock.install()
  await typeBurst(page, ['12', '14'])
  await expect.poll(() => setCalls(page)).toEqual([{ fontSize: 14 }])
  await typeBurst(page, ['16'])
  await fontSize(page).blur()
  expect(await setCalls(page)).toEqual([{ fontSize: 14 }, { fontSize: 16 }])
  await expect(fontSize(page)).toHaveValue('16')
  await page.clock.runFor(PAST_TYPING_PAUSE_MS)
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
    const w = window
    w.devotIpcMocks = {
      ...w.devotIpcMocks,
      editor_settings_set: { error: 'E_EDITOR_SETTINGS_WRITE_FAILED' },
    }
  })
  // Clicked, not checked: the box is checked only until the store refuses.
  await checkbox(page, 'Line Numbers').click()
  await expect(editor(page).getByRole('alert')).toHaveText(
    'The editor settings could not be saved.',
  )
  await expect(checkbox(page, 'Line Numbers')).not.toBeChecked()
})

const preview = (page: Page) => page.getByRole('region', { name: 'Preview' })

test('Preview has synced scrolling; its font size sits in Appearance', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window
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

test('Preview loads images from the web by default and can make them wait', async ({ page }) => {
  await page.addInitScript(() => {
    window.devotIpcMocks = { usage_list: [] }
  })
  await openSettings(page, 'Preview')
  const remote = preview(page).getByRole('switch', { name: 'Load Images from the Web' })
  await expect(remote).toBeChecked()
  await remote.uncheck()
  await expect.poll(() => setCalls(page)).toEqual([{ loadRemoteImages: false }])
})

test('Integrations says under AI Tools when no notebook allows AI access, and opens nothing', async ({
  page,
}) => {
  await page.addInitScript((setup) => {
    const w = window
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: { notebooks: 3, allowed: 0 },
      main_window_show: null,
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  await expect(aiTools).toContainText('0 of 3 notebooks allow AI access.')
  const notes = aiTools.locator('.settings-footnote')
  await expect(notes.first()).toContainText('No notebook allows AI access yet')
  await expect(notes.first()).toContainText('right-click a notebook in the sidebar')
  await expect(notes.first().locator('.icon')).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await aiTools.getByRole('button', { name: 'Choose\u2026' }).click()
  expect(await calls(page, 'main_window_show')).toEqual([{ cmd: 'main_window_show', args: {} }])
  // The main window reads this flag when it gains focus.
  expect(await page.evaluate(() => localStorage.getItem('devot:choose-ai-access'))).toBe('1')
})

test('the AI access notice goes once a notebook allows access', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = window
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: () => ({ notebooks: 2, allowed: w.allowed ?? 0 }),
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  await expect(aiTools).toContainText('No notebook allows AI access yet')
  await page.evaluate(() => {
    window.allowed = 1
    window.dispatchEvent(new Event('focus'))
  })
  await expect(aiTools).toContainText('1 of 2 notebooks allow AI access.')
  await expect(aiTools).not.toContainText('No notebook allows AI access yet')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Integrations says how to create a notebook when there is none', async ({ page }) => {
  await page.addInitScript((setup) => {
    const w = window
    w.devotIpcMocks = {
      settings_mcp_setup: setup,
      settings_ai_access_summary: { notebooks: 0, allowed: 0 },
    }
  }, setupWith())
  await openSettings(page, 'Integrations')
  const aiTools = page.getByRole('region', { name: 'AI Tools' })
  await expect(aiTools.locator('.settings-footnote').first()).toContainText(
    'Devot has no notebooks yet',
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
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
  await expect(page.locator('.settings-search')).toHaveCSS('border-radius', sizes['radius.capsule'])

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

test('cards end on one right edge whether or not the pane scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 680 })
  await openSettings(page, 'General')
  const edges = async (pane: string) => {
    await tab(page, pane).click()
    await expect(page.getByRole('tabpanel', { name: pane })).toBeVisible()
    return page.evaluate(() => {
      const scroller = document.querySelector('.settings-pane')!
      return {
        scrolls: scroller.scrollHeight > scroller.clientHeight,
        rights: [...document.querySelectorAll('.settings-card')].map(
          (card) => card.getBoundingClientRect().right,
        ),
      }
    })
  }
  const general = await edges('General')
  const previewPane = await edges('Preview')
  expect([general.scrolls, previewPane.scrolls]).toEqual([true, false])
  const right = general.rights[0]!
  for (const edge of [...general.rights, ...previewPane.rights]) expect(edge).toBeCloseTo(right, 1)
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
    const w = window
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
    const w = window
    w.devotIpcMocks = { crash_reports_get: { available: false, on: false } }
  })
  await page.goto('/settings.html')
  await expect(page.getByRole('switch', { name: 'Send Crash Reports' })).toHaveCount(0)
})
