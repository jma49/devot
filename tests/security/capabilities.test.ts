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

// The main capability covers `main` and the windows File > New Window opens (`main-*`), which are
// the same window kind; the lists below name it once, as `main`.
const MAIN_WINDOWS = ['main', 'main-*']

const windowsWith = (permission: string) =>
  capabilities()
    .filter((c) => permissionIds(c).includes(permission))
    .flatMap((c) => c.windows)
    .filter((w) => w !== 'main-*')
    .sort()

describe('Tauri command permissions', () => {
  it('gives every main window the same permissions, in one capability', () => {
    const mains = capabilities().filter((c) => c.windows.some((w) => MAIN_WINDOWS.includes(w)))
    expect(mains.map((c) => c.windows)).toEqual([MAIN_WINDOWS])
  })

  it('lets only main windows open another one and tell the others the library changed', () => {
    expect(windowsWith('allow-main-window-new')).toEqual(['main'])
    expect(windowsWith('allow-main-windows-changed')).toEqual(['main'])
  })

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

  it('lets only the Settings window install, turn on and off and remove plugins, and only the main window run their formats', () => {
    for (const command of [
      'allow-plugin-install-pick',
      'allow-plugin-install-confirm',
      'allow-plugin-install-cancel',
      'allow-plugin-set-enabled',
      'allow-plugin-remove',
    ]) {
      expect(windowsWith(command)).toEqual(['settings'])
    }
    expect(windowsWith('allow-plugins-list')).toEqual(['main', 'settings'])
    expect(windowsWith('allow-plugin-import-pick')).toEqual(['main'])
    expect(windowsWith('allow-plugin-export-save')).toEqual(['main'])
  })

  it('lets the windows read the editor settings, the main and Settings windows change them, and the Settings window nothing more', () => {
    expect(windowsWith('allow-editor-settings-get')).toEqual([
      'main',
      'note-*',
      'quick-capture',
      'settings',
    ])
    expect(windowsWith('allow-editor-settings-set')).toEqual(['main', 'settings'])
    const settings = capabilities().filter((c) => c.windows.includes('settings'))
    // It hears changes made in the main window (Cmd+= and Cmd+-) as events.
    expect(settings.flatMap(permissionIds).sort()).toEqual([
      // Settings > AI sets the endpoints and models, and puts keys in; none comes back out.
      'allow-ai-key-clear',
      'allow-ai-key-set',
      'allow-ai-settings-get',
      'allow-ai-settings-set',
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
      // Settings > Integrations turns the local HTTP API on and off and shows and replaces its token.
      'allow-http-api-get',
      'allow-http-api-set',
      'allow-http-api-token-reveal',
      'allow-http-api-token-rotate',
      'allow-keyboard-shortcuts-get',
      'allow-keyboard-shortcuts-set',
      // Settings > Licence adds a key (which never comes back out), shows its state and removes it.
      'allow-licence-get',
      'allow-licence-remove',
      'allow-licence-set',
      'allow-mirror-choose',
      'allow-mirror-confirm',
      'allow-mirror-get',
      'allow-mirror-set',
      // Settings > Licence opens the Buy and Renew pages in the browser.
      'allow-open-external',
      // Settings > Plugins installs plugins after the user approves their permissions, turns them on and off and removes them.
      'allow-plugin-install-cancel',
      'allow-plugin-install-confirm',
      'allow-plugin-install-pick',
      'allow-plugin-remove',
      'allow-plugin-set-enabled',
      'allow-plugins-list',
      'allow-settings-mcp-setup',
      'allow-settings-open-data-folder',
      'allow-settings-show-backups',
      'allow-symbol-png',
      // Settings > Sync sets the relay and turns sync on or off; the relay's secret goes in, once.
      'allow-sync-get',
      'allow-sync-set',
      'allow-sync-vault-create',
      'allow-system-accent',
      'allow-update-check',
      'allow-update-status',
      'allow-usage-clear',
      'allow-usage-list',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ])
  })

  it('lets the main and Settings windows read and add a licence, and only Settings remove it', () => {
    expect(windowsWith('allow-licence-get')).toEqual(['main', 'settings'])
    // The main window adds the key a devot://licence link brings, once the user agrees.
    expect(windowsWith('allow-licence-set')).toEqual(['main', 'settings'])
    expect(windowsWith('allow-licence-remove')).toEqual(['settings'])
  })

  it('lets only the main window run sync, and only the Settings window set it up', () => {
    for (const run of [
      'allow-sync-connect',
      'allow-sync-pull',
      'allow-sync-push',
      'allow-sync-disconnect',
      'allow-sync-status-report',
      'allow-sync-pending',
      'allow-sync-read',
      'allow-sync-entry-put',
      'allow-sync-state-get',
      'allow-sync-state-put',
      'allow-sync-reset',
      'allow-sync-note-purge',
    ]) {
      expect(windowsWith(run)).toEqual(['main'])
    }
    expect(windowsWith('allow-sync-get')).toEqual(['main', 'settings'])
    expect(windowsWith('allow-sync-set')).toEqual(['settings'])
    expect(windowsWith('allow-sync-vault-create')).toEqual(['settings'])
  })

  it('lets every window read the system accent colour', () => {
    expect(windowsWith('allow-system-accent')).toEqual([
      'main',
      'note-*',
      'quick-capture',
      'settings',
    ])
  })

  it('lets a note window edit its note, relay its changes and save before it closes, and nothing more', () => {
    const noteWindow = capabilities().filter((c) => c.windows.includes('note-*'))
    // No notebook or tag changes, imports, exports, backups, mirror or settings changes: those
    // stay in the main window. It reads the notebooks only to make a linked note in one.
    expect(noteWindow.flatMap(permissionIds).sort()).toEqual([
      'allow-app-exit-cancel',
      'allow-app-exit-ready',
      'allow-books-list',
      'allow-clipboard-read-text',
      'allow-clipboard-write-text',
      'allow-editor-menu-popup',
      'allow-editor-settings-get',
      'allow-file-put',
      'allow-font-read',
      'allow-github-snippet',
      'allow-image-copy',
      'allow-image-save',
      'allow-keyboard-shortcuts-get',
      'allow-link-title',
      'allow-log-write',
      'allow-note-get',
      'allow-note-purge',
      'allow-note-put',
      'allow-note-relay-send',
      'allow-note-window-close-cancel',
      'allow-note-window-close-ready',
      'allow-note-window-note',
      'allow-note-window-open',
      'allow-notes-bodies',
      'allow-notes-list',
      'allow-notes-search',
      'allow-open-external',
      'allow-revision-get',
      'allow-revision-put',
      'allow-revisions-delete',
      'allow-revisions-list',
      'allow-symbol-png',
      'allow-system-accent',
      'allow-tags-list',
      'allow-text-look-up',
      'allow-text-speak',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
      'core:window:allow-set-title',
    ])
    expect(windowsWith('allow-note-relay-send')).toEqual(['main', 'note-*'])
    expect(windowsWith('allow-note-window-open')).toEqual(['main', 'note-*'])
    expect(windowsWith('allow-note-window-note')).toEqual(['note-*'])
    // A window File > New Window opens closes through the same handshake.
    for (const command of ['close-ready', 'close-cancel']) {
      expect(windowsWith(`allow-note-window-${command}`)).toEqual(['main', 'note-*'])
    }
  })

  it('grants the main windows every command the secondary-window close handler invokes', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const start = app.indexOf('if (primary) return\n    const closed')
    expect(start).toBeGreaterThan(-1)
    const handler = app.slice(start, app.indexOf('CLOSE_EVENT, closed)', start))
    const commands = [...handler.matchAll(/invoke\('([a-z_]+)'/g)].map((m) => m[1] ?? '')
    expect(commands).toContain('note_window_close_ready')
    const granted = capabilities()
      .filter((c) => c.windows.includes('main-*'))
      .flatMap(permissionIds)
    const missing = commands.filter((c) => !granted.includes(`allow-${c.replaceAll('_', '-')}`))
    expect(missing).toEqual([])
  })

  it('grants a note window every command its page and its core can reach', () => {
    const invoked = (file: string) =>
      [...readFileSync(file, 'utf8').matchAll(/invoke(?:<[^>]*>)?\('([a-z_]+)'/g)].map(
        (m) => m[1] ?? '',
      )
    // Its core never changes notebooks or tags, applies a template, lists the Trash, compacts the
    // history or shows activity: those start in the main window.
    const mainOnly = [
      'activity_list',
      'book_put',
      'files_copy',
      'note_tag_get',
      'note_tag_put',
      'notes_trash_list',
      'revisions_compact',
      'revisions_compactable',
      'revisions_last_compaction',
      'tag_put',
    ]
    const reached = [
      ...invoked('src/renderer/src/storage/tauri.ts').filter((c) => !mainOnly.includes(c)),
      ...invoked('src/renderer/src/noteWindow/NoteWindow.tsx'),
      ...invoked('src/renderer/src/noteRelay.ts'),
    ]
    const granted = capabilities()
      .filter((c) => c.windows.includes('note-*'))
      .flatMap(permissionIds)
    const missing = reached.filter((c) => !granted.includes(`allow-${c.replaceAll('_', '-')}`))
    expect(missing).toEqual([])
  })

  it('lets the quick capture window hand over its note and close, and nothing more', () => {
    const quickCapture = capabilities().filter((c) => c.windows.includes('quick-capture'))
    // No notes, no files: the main window's core saves the note.
    expect(quickCapture.flatMap(permissionIds).sort()).toEqual([
      'allow-editor-settings-get',
      'allow-quick-capture-close',
      'allow-quick-capture-save',
      'allow-system-accent',
      'core:event:allow-listen',
      'core:event:allow-unlisten',
    ])
    expect(windowsWith('allow-quick-capture-done')).toEqual(['main'])
  })

  it('lets only Settings see or replace the HTTP API token, and only the main window answer its calls', () => {
    for (const command of ['get', 'set', 'token-reveal', 'token-rotate']) {
      expect(windowsWith(`allow-http-api-${command}`)).toEqual(['settings'])
    }
    expect(windowsWith('allow-http-api-done')).toEqual(['main'])
  })

  it('grants no window a global shortcut command: Rust alone registers the shortcut', () => {
    expect(
      capabilities()
        .flatMap(permissionIds)
        .filter((p) => p.startsWith('global-shortcut:')),
    ).toEqual([])
  })

  it('lets only the main window generate, the main and Settings windows read the settings, and only the Settings window set providers and keys', () => {
    expect(windowsWith('allow-ai-generate')).toEqual(['main'])
    expect(windowsWith('allow-ai-settings-get')).toEqual(['main', 'settings'])
    for (const command of ['settings-set', 'key-set', 'key-clear']) {
      expect(windowsWith(`allow-ai-${command}`)).toEqual(['settings'])
    }
  })

  it('lets only the Settings window import and list fonts, and the main, Settings and note windows load one', () => {
    for (const command of ['font-import', 'fonts-list', 'fonts-installed']) {
      expect(windowsWith(`allow-${command}`)).toEqual(['settings'])
    }
    expect(windowsWith('allow-font-read')).toEqual(['main', 'note-*', 'settings'])
  })

  it('lets both windows check for updates, and only the main window download, skip and restart', () => {
    for (const command of ['status', 'check']) {
      expect(windowsWith(`allow-update-${command}`)).toEqual(['main', 'settings'])
    }
    for (const command of ['download', 'skip', 'restart']) {
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
    expect(windowsWith('allow-keyboard-shortcuts-get')).toEqual(['main', 'note-*', 'settings'])
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
