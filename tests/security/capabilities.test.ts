import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Commands declared in build.rs need an explicit `allow-<command>` grant.
function declaredCommands(): string[] {
  const build = readFileSync('src-tauri/build.rs', 'utf8')
  const list = build.match(/\.commands\(&\[([^\]]*)\]\)/)?.[1] ?? ''
  return [...list.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1] ?? '')
}

interface Capability {
  windows: string[]
  permissions: (string | { identifier: string })[]
}

function capabilities(): Capability[] {
  const dir = 'src-tauri/capabilities'
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Capability)
}

const permissionIds = (c: Capability) =>
  c.permissions.map((p) => (typeof p === 'string' ? p : p.identifier))

function grantedAppPermissions(): string[] {
  return [
    ...new Set(
      capabilities()
        .flatMap(permissionIds)
        .filter((p) => !p.includes(':')),
    ),
  ]
}

const windowsWith = (permission: string) =>
  capabilities()
    .filter((c) => permissionIds(c).includes(permission))
    .flatMap((c) => c.windows)
    .sort()

describe('Tauri command permissions', () => {
  it('declares at least one app command', () => {
    expect(declaredCommands().length).toBeGreaterThan(0)
  })

  it('grants exactly the declared commands, nothing more', () => {
    const expected = declaredCommands()
      .map((c) => `allow-${c.replaceAll('_', '-')}`)
      .sort()
    expect(grantedAppPermissions().sort()).toEqual(expected)
  })

  it('lets only the Settings window read and clear usage events, and only the main window record them', () => {
    expect(windowsWith('allow-usage-list')).toEqual(['settings'])
    expect(windowsWith('allow-usage-clear')).toEqual(['settings'])
    expect(windowsWith('allow-usage-record')).toEqual(['main'])
  })

  it('lets both windows read and change the editor settings, and the Settings window nothing more', () => {
    expect(windowsWith('allow-editor-settings-get')).toEqual(['main', 'settings'])
    expect(windowsWith('allow-editor-settings-set')).toEqual(['main', 'settings'])
    const settings = capabilities().filter((c) => c.windows.includes('settings'))
    // It hears changes made in the main window (Cmd+= and Cmd+-) as events.
    expect(settings.flatMap(permissionIds).sort()).toEqual([
      'allow-cli-tool-install',
      'allow-cli-tool-status',
      'allow-cli-tool-uninstall',
      // Settings > Integrations copies devot-mcp's configs.
      'allow-clipboard-write-text',
      'allow-editor-settings-get',
      'allow-editor-settings-set',
      'allow-font-import',
      'allow-font-read',
      'allow-fonts-installed',
      'allow-fonts-list',
      'allow-keyboard-shortcuts-get',
      'allow-keyboard-shortcuts-set',
      'allow-mirror-choose',
      'allow-mirror-confirm',
      'allow-mirror-get',
      'allow-mirror-set',
      'allow-settings-mcp-setup',
      'allow-settings-open-data-folder',
      'allow-settings-show-backups',
      'allow-symbol-png',
      'allow-system-accent',
      'allow-update-check',
      'allow-update-status',
      'allow-usage-clear',
      'allow-usage-list',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ])
  })

  it('lets both windows read the system accent colour', () => {
    expect(windowsWith('allow-system-accent')).toEqual(['main', 'settings'])
  })

  it('lets only the Settings window import and list fonts, and both windows load one', () => {
    for (const command of ['font-import', 'fonts-list', 'fonts-installed']) {
      expect(windowsWith(`allow-${command}`)).toEqual(['settings'])
    }
    expect(windowsWith('allow-font-read')).toEqual(['main', 'settings'])
  })

  it('lets both windows check for updates, and only the main window download and restart', () => {
    for (const command of ['status', 'check']) {
      expect(windowsWith(`allow-update-${command}`)).toEqual(['main', 'settings'])
    }
    for (const command of ['download', 'restart']) {
      expect(windowsWith(`allow-update-${command}`)).toEqual(['main'])
    }
  })

  it('lets only the main window take the links other apps opened', () => {
    expect(windowsWith('allow-deep-link-take')).toEqual(['main'])
  })

  it('grants no window a deep-link or single-instance plugin command', () => {
    const plugin = capabilities()
      .flatMap(permissionIds)
      .filter((p) => p.startsWith('deep-link:') || p.startsWith('single-instance:'))
    expect(plugin).toEqual([])
  })

  it('lets only the Settings window open the data folder, ask for the Backups dialog and find devot-mcp', () => {
    for (const command of ['open-data-folder', 'show-backups', 'mcp-setup']) {
      expect(windowsWith(`allow-settings-${command}`)).toEqual(['settings'])
    }
  })

  it('lets only the Settings window change the keyboard shortcuts, and only the main window set the menu keys', () => {
    expect(windowsWith('allow-keyboard-shortcuts-get')).toEqual(['main', 'settings'])
    expect(windowsWith('allow-keyboard-shortcuts-set')).toEqual(['settings'])
    expect(windowsWith('allow-command-menu-set')).toEqual(['main'])
  })

  it("lets both windows see and change the Markdown mirror's setting, and only the main window run it", () => {
    for (const command of ['get', 'set', 'choose', 'confirm']) {
      expect(windowsWith(`allow-mirror-${command}`)).toEqual(['main', 'settings'])
    }
    for (const command of ['open', 'check', 'apply', 'bodies', 'files', 'hashes']) {
      expect(windowsWith(`allow-mirror-${command}`)).toEqual(['main'])
    }
  })

  it('lets only the Settings window install the devot command', () => {
    for (const command of ['status', 'install', 'uninstall']) {
      expect(windowsWith(`allow-cli-tool-${command}`)).toEqual(['settings'])
    }
  })

  it('gives the hidden window of devot export its own commands and nothing else', () => {
    const window = capabilities().filter((c) => c.windows.includes('cli-export'))
    expect(window.flatMap(permissionIds).sort()).toEqual([
      'allow-cli-export-fail',
      'allow-cli-export-finish',
      'allow-cli-export-source',
    ])
    for (const command of ['source', 'finish', 'fail']) {
      expect(windowsWith(`allow-cli-export-${command}`)).toEqual(['cli-export'])
    }
  })

  it('lets only the main window export, print and copy a note as HTML', () => {
    for (const command of [
      'export-begin',
      'export-attach',
      'export-write',
      'export-finish',
      'export-pdf',
      'note-print',
      'clipboard-write-html',
    ]) {
      expect(windowsWith(`allow-${command}`)).toEqual(['main'])
    }
  })
})
