import { expect, test as base, type Locator, type Page } from '@playwright/test'

// A 1x1 black PNG: what `symbol_png` returns, at a smaller size.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export interface IpcCall {
  cmd: string
  args: Record<string, unknown>
}

/** A native menu or menu item created through `plugin:menu|new`, by resource ID. */
export interface MockMenu {
  kind: string
  options: {
    id?: string
    text?: string
    accelerator?: string
    checked?: boolean
    items?: [number, string][]
  }
  /** The item's action channel: a message on it is a click on the item. */
  handler?: { onmessage: (id: unknown) => void }
}

/** The page's globals these tests touch (this config has no DOM types). */
export interface TestWindow {
  devotIpcCalls: IpcCall[]
  devotIpcMocks?: Record<string, unknown>
  devotMenus: Record<number, MockMenu>
  /** The stored editor settings (only those set; the rest are defaults). */
  devotEditorSettings?: Record<string, unknown>
  /** Their revision, counted up with each change as Rust does. */
  devotEditorRevision?: number
  /** The stored keyboard shortcut changes (command ID to keys). */
  devotShortcutOverrides?: Record<string, string[]>
  /** Their revision, counted up with each change as Rust does. */
  devotShortcutRevision?: number
  /** The Markdown mirror as Rust holds it (see `mirror_*` below); off when unset. */
  devotMirror?: MockMirror
  /**
   * What the folder panel picks next for `mirror_choose`: a folder (used at
   * once when `empty`, else after `mirror_confirm`); nothing cancels.
   */
  devotMirrorPick?: { folder: string; name: string; empty: boolean } | null
  /** The operations `mirror_apply` ran, in order. */
  devotMirrorApplied?: { kind: string; id: string; path?: string | null; text?: string }[]
}

/** The mirror's status as Rust sends it, and its manifest. */
export interface MockMirror {
  revision: number
  generation: number
  folder: string | null
  includeAttachments: boolean
  paused: string | null
  size: number | null
  kept: string[]
  keptCount: number
  manifest?: {
    notes: Record<string, unknown>
    files: Record<string, unknown>
    books: Record<string, unknown>
  }
}

/**
 * Every UI test runs with Object.prototype frozen (as the app does) and
 * Tauri's IPC mocked: commands are recorded in
 * `window.devotIpcCalls` and `symbol_png` answers with a tiny PNG. Native
 * menus are kept in `window.devotMenus` (see `shownMenu`, `pickMenuItem`);
 * `clipboard_write_text`, `usage_record`, `format_menu_set` and
 * `sidebar_menu_set` succeed (and so does `settings_fit`, the Settings window
 * fitting its pane), and
 * `sidebar_material_sync` answers with the stored sidebar material. The editor settings live
 * in `window.devotEditorSettings` (revision `devotEditorRevision`; see
 * `changeEditorSettingsElsewhere`): `editor_settings_set` merges its change
 * into them and, as Rust does for every window, sends
 * `devot:editor-settings-changed` (the page event the app re-sends Rust's
 * event as). The keyboard shortcut changes live in
 * `window.devotShortcutOverrides` the same way (`keyboard_shortcuts_set`
 * applies its patch and sends `devot:keyboard-shortcuts-changed`; see
 * `changeShortcutsElsewhere`), and `command_menu_set` succeeds. The Markdown
 * mirror is off unless a test sets `window.devotMirror`; its commands keep
 * the status and setting as Rust does (sending `devot:mirror-changed`), pick
 * `devotMirrorPick` in the folder panel, and record the window's passes in
 * `devotMirrorApplied`. Storage stays in the in-memory adapter (the UI
 * tests' build, vite.ui-test.config.ts).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await mockTauri(page)
    const rebundled: string[] = []
    page.on('console', (message) => {
      if (REBUNDLED.test(message.text())) rebundled.push(message.text())
    })
    await use(page)
    // Vite found a dependency late, re-bundled and reloaded the page under
    // the test (`optimizeDeps.entries` in vite.config.ts names them all up
    // front): the test acted on a page that was about to go away.
    if (rebundled.length > 0)
      throw new Error(`Vite re-bundled while the page was open: ${rebundled[0]}`)
  },
})

/**
 * Opens the app and returns once the window is ready (`data-ready` on
 * `.window`): its lists have loaded, its last state is restored and every
 * listener it adds in an effect is in place. Acting right after `page.goto`
 * can lose a key or an event that no listener heard yet.
 */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await appReady(page)
}

/**
 * Opens the Settings window on the pane whose toolbar tab is `tab` (it opens
 * on the pane shown last, General at first).
 */
export async function openSettings(page: Page, tab: string): Promise<void> {
  await page.goto('/settings.html')
  await page.getByRole('tab', { name: tab, exact: true }).click()
}

/** Reloads the page and returns once the window is ready (see `openApp`). */
export async function reloadApp(page: Page): Promise<void> {
  await page.reload()
  await appReady(page)
}

/** Waits for the window to be ready (see `openApp`). */
export function appReady(page: Page): Promise<void> {
  return page.locator('.window[data-ready]').waitFor()
}

/** What Vite's client logs when its dependency pre-bundle changed under an open page. */
const REBUNDLED = /new dependencies optimized|optimized dependencies changed/

/** Sets up a page as `test` does; for a second page (another window). */
export async function mockTauri(page: Page): Promise<void> {
  await page.addInitScript((png) => {
    // As in the app: Tauri's `freezePrototype` freezes Object.prototype in
    // the main frame (not in subframes) before any page script runs.
    if ((globalThis as unknown as { top: unknown }).top === globalThis)
      Object.freeze(Object.prototype)
    const w = globalThis as unknown as TestWindow
    w.devotIpcCalls = []
    w.devotMenus = {}
    let nextRid = 1
    Object.defineProperty(w, '__TAURI_INTERNALS__', {
      value: {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          w.devotIpcCalls.push({ cmd, args })
          if (cmd === 'symbol_png') return png
          if (cmd === 'log_write') return null
          // Per-test answers: `devotIpcMocks[cmd]`, or `{ error }` to fail.
          const mock = w.devotIpcMocks?.[cmd]
          if (mock !== undefined) {
            if (typeof mock === 'object' && mock !== null && 'error' in mock) throw mock.error
            return typeof mock === 'function' ? (mock as (a: unknown) => unknown)(args) : mock
          }
          if (
            cmd === 'clipboard_write_text' ||
            cmd === 'usage_record' ||
            cmd === 'format_menu_set' ||
            cmd === 'sidebar_menu_set' ||
            cmd === 'command_menu_set' ||
            cmd === 'settings_fit'
          )
            return null
          if (cmd === 'keyboard_shortcuts_get')
            return {
              revision: w.devotShortcutRevision ?? 0,
              overrides: w.devotShortcutOverrides ?? {},
            }
          if (cmd === 'keyboard_shortcuts_set') {
            const next: Record<string, string[]> = { ...w.devotShortcutOverrides }
            for (const [id, keys] of Object.entries(args['patch'] as object)) {
              if (keys === null) delete next[id]
              else next[id] = keys as string[]
            }
            w.devotShortcutOverrides = next
            w.devotShortcutRevision = (w.devotShortcutRevision ?? 0) + 1
            const snapshot = { revision: w.devotShortcutRevision, overrides: next }
            const win = globalThis as unknown as {
              dispatchEvent(e: unknown): void
              CustomEvent: new (t: string, init: { detail: unknown }) => unknown
            }
            win.dispatchEvent(
              new win.CustomEvent('devot:keyboard-shortcuts-changed', { detail: snapshot }),
            )
            return snapshot
          }
          // Rust brings the window effect in line; the material it shows.
          if (cmd === 'sidebar_material_sync')
            return (w.devotEditorSettings?.['sidebarMaterial'] ?? true) !== false
          if (cmd === 'editor_settings_get')
            return { revision: w.devotEditorRevision ?? 0, settings: w.devotEditorSettings ?? {} }
          if (cmd === 'editor_settings_set') {
            w.devotEditorSettings = { ...w.devotEditorSettings, ...(args['patch'] as object) }
            w.devotEditorRevision = (w.devotEditorRevision ?? 0) + 1
            const next = { revision: w.devotEditorRevision, settings: w.devotEditorSettings }
            const win = globalThis as unknown as {
              dispatchEvent(e: unknown): void
              CustomEvent: new (t: string, init: { detail: unknown }) => unknown
            }
            win.dispatchEvent(
              new win.CustomEvent('devot:editor-settings-changed', { detail: next }),
            )
            return next
          }
          // The Markdown mirror: status and setting as Rust keeps them, and a
          // pass side that records what the window's passes do.
          if (cmd.startsWith('mirror_')) {
            const win = globalThis as unknown as {
              dispatchEvent(e: unknown): void
              CustomEvent: new (t: string, init: { detail: unknown }) => unknown
              localStorage: { getItem(key: string): string | null }
            }
            const mirror = (w.devotMirror ??= {
              revision: 0,
              generation: 0,
              folder: null,
              includeAttachments: true,
              paused: null,
              size: 0,
              kept: [],
              keptCount: 0,
            })
            const status = () => {
              const { manifest, ...rest } = mirror
              void manifest
              return { ...rest, kept: [...rest.kept] }
            }
            const announce = () => {
              mirror.revision += 1
              win.dispatchEvent(new win.CustomEvent('devot:mirror-changed', { detail: status() }))
              return status()
            }
            const use = (folder: string) => {
              mirror.folder = folder
              mirror.generation += 1
              mirror.paused = null
              mirror.kept = []
              mirror.keptCount = 0
              mirror.manifest = { notes: {}, files: {}, books: {} }
              return announce()
            }
            if (cmd === 'mirror_get') return status()
            if (cmd === 'mirror_set') {
              const patch = args['patch'] as Record<string, unknown>
              if (patch['includeAttachments'] !== undefined) {
                mirror.includeAttachments = patch['includeAttachments'] as boolean
                mirror.generation += 1
              }
              if (patch['turnOff']) {
                mirror.folder = null
                mirror.generation += 1
                mirror.paused = null
                mirror.kept = []
                mirror.keptCount = 0
              }
              if (patch['dismissKept']) {
                mirror.kept = []
                mirror.keptCount = 0
              }
              return announce()
            }
            if (cmd === 'mirror_choose') {
              const pick = w.devotMirrorPick
              if (!pick) return { kind: 'cancelled' }
              if (pick.empty) return { kind: 'chosen', status: use(pick.folder) }
              return { kind: 'confirm', token: 7, name: pick.name }
            }
            if (cmd === 'mirror_confirm') {
              const pick = w.devotMirrorPick
              if (args['token'] !== 7 || !pick) throw 'E_MIRROR_CHOICE_UNKNOWN'
              return use(pick.folder)
            }
            if (mirror.folder === null) throw 'E_MIRROR_OFF'
            const manifest = (mirror.manifest ??= { notes: {}, files: {}, books: {} })
            if (cmd === 'mirror_open') {
              return {
                generation: mirror.generation,
                includeAttachments: mirror.includeAttachments,
                manifest:
                  args['known'] === mirror.generation ? null : JSON.parse(JSON.stringify(manifest)),
              }
            }
            if (cmd === 'mirror_bodies') {
              const ids = new Set(args['ids'] as string[])
              const notes = JSON.parse(win.localStorage.getItem('devot.test.notes') ?? '[]') as {
                id: string
                bodyMd: string
                deletedAt: number | null
                purgedAt?: number
              }[]
              return notes
                .filter((n) => ids.has(n.id) && n.deletedAt === null && n.purgedAt === undefined)
                .map((n) => ({ id: n.id, bodyMd: n.bodyMd }))
            }
            if (cmd === 'mirror_files' || cmd === 'mirror_hashes') return []
            if (cmd === 'mirror_check') {
              // Every file holds what the manifest says; nothing else is there.
              const held = new Map(
                Object.values(manifest.notes).map((e) => {
                  const entry = e as { path: string; sha256: string }
                  return [entry.path, entry.sha256]
                }),
              )
              const paths = args['paths'] as string[] | null
              return Object.fromEntries((paths ?? []).map((p) => [p, held.get(p) ?? null]))
            }
            if (cmd === 'mirror_apply') {
              const applied = (w.devotMirrorApplied ??= [])
              return (args['ops'] as Record<string, unknown>[]).map((op) => {
                const id = op['id'] as string
                applied.push({
                  kind: op['kind'] as string,
                  id,
                  path: (op['path'] as string | null | undefined) ?? null,
                  ...(typeof op['text'] === 'string' ? { text: op['text'] } : {}),
                })
                const size = typeof op['text'] === 'string' ? op['text'].length : 0
                if (op['kind'] === 'note') {
                  const { kind, text, from, ...entry } = op
                  void kind
                  void text
                  void from
                  manifest.notes[id] = { ...entry, size }
                } else if (op['kind'] === 'book') {
                  if (op['path'] === null) delete manifest.books[id]
                  else manifest.books[id] = op['path']
                } else if (op['kind'] === 'file') {
                  manifest.files[id] = { path: op['path'], sha256: null, size: 0 }
                } else if (op['entry'] === 'note') delete manifest.notes[id]
                else delete manifest.files[id]
                return { size }
              })
            }
            throw new Error(`E_TEST_UNMOCKED_COMMAND ${cmd}`)
          }
          if (cmd === 'plugin:menu|new') {
            const rid = nextRid++
            const menu = args as unknown as MockMenu & { options?: MockMenu['options'] }
            w.devotMenus[rid] = {
              kind: menu.kind,
              options: menu.options ?? {},
              ...(menu.handler ? { handler: menu.handler } : {}),
            }
            return [rid, menu.options?.id ?? `menu-${rid}`]
          }
          if (cmd === 'plugin:menu|set_text') {
            const item = w.devotMenus[args['rid'] as number]
            if (item) item.options.text = args['text'] as string
            return null
          }
          if (cmd === 'plugin:menu|set_checked') {
            const item = w.devotMenus[args['rid'] as number]
            if (item) item.options.checked = args['checked'] as boolean
            return null
          }
          // A context menu shows or hides items for each target.
          if (cmd === 'plugin:menu|insert' || cmd === 'plugin:menu|remove') {
            const menu = w.devotMenus[args['rid'] as number]
            if (!menu) throw new Error('E_TEST_NO_MENU')
            const items = (menu.options.items ??= [])
            if (cmd === 'plugin:menu|insert') {
              items.splice(args['position'] as number, 0, ...(args['items'] as [number, string][]))
            } else {
              const [rid] = args['item'] as [number, string]
              const at = items.findIndex(([r]) => r === rid)
              if (at < 0) throw new Error('E_TEST_NOT_IN_MENU')
              items.splice(at, 1)
            }
            return null
          }
          if (cmd === 'plugin:menu|popup' || cmd === 'plugin:resources|close') return null
          throw new Error(`E_TEST_UNMOCKED_COMMAND ${cmd}`)
        },
        transformCallback: () => 0,
        unregisterCallback: () => {},
      },
    })
  }, PNG)
}

export { expect } from '@playwright/test'

/** `symbol_png` requests so far, as `name@size`. */
export function symbolRequests(calls: IpcCall[]): string[] {
  return calls
    .filter((c) => c.cmd === 'symbol_png')
    .map((c) => `${String(c.args['name'])}@${String(c.args['pointSize'])}`)
}

/**
 * The native menu shown last, one line per item: its label and accelerator,
 * then `[x]` or `[ ]` for a check item, or `---` for a separator. A submenu
 * shows as `<label> >`, its items after it, indented by two spaces.
 */
export async function shownMenu(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    const popup = w.devotIpcCalls.findLast((c) => c.cmd === 'plugin:menu|popup')
    const menu = popup ? w.devotMenus[popup.args['rid'] as number] : undefined
    const lines = (items: [number, string][], indent: string): string[] =>
      items.flatMap(([rid]) => {
        const item = w.devotMenus[rid]
        if (!item || item.kind === 'Predefined') return ['---']
        const { text = '', accelerator, checked } = item.options
        if (item.kind === 'Submenu') {
          return [`${indent}${text} >`, ...lines(item.options.items ?? [], `${indent}  `)]
        }
        const line = accelerator ? `${text} ${accelerator}` : text
        return [`${indent}${item.kind === 'Check' ? `${line} ${checked ? '[x]' : '[ ]'}` : line}`]
      })
    return lines(menu?.options.items ?? [], '')
  })
}

/**
 * Clicks the item with this label in the native menu shown last; with
 * `submenu`, in the submenu with that label.
 */
export async function pickMenuItem(page: Page, label: string, submenu?: string): Promise<void> {
  const picked = await page.evaluate(
    ([text, parent]) => {
      const w = globalThis as unknown as TestWindow
      const popup = w.devotIpcCalls.findLast((c) => c.cmd === 'plugin:menu|popup')
      let menu = popup ? w.devotMenus[popup.args['rid'] as number] : undefined
      if (parent !== undefined) {
        const rid = menu?.options.items?.find(
          ([r]) => w.devotMenus[r]?.kind === 'Submenu' && w.devotMenus[r]?.options.text === parent,
        )?.[0]
        menu = rid === undefined ? undefined : w.devotMenus[rid]
      }
      for (const [rid] of menu?.options.items ?? []) {
        const item = w.devotMenus[rid]
        if (item?.options.text === text && item.handler) {
          item.handler.onmessage(item.options.id)
          return true
        }
      }
      return false
    },
    [label, submenu] as const,
  )
  if (!picked) throw new Error(`E_TEST_NO_MENU_ITEM ${submenu ? `${submenu} > ` : ''}${label}`)
}

/** The texts written to the clipboard so far, oldest first. */
export async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'clipboard_write_text')
      .map((c) => String(c.args['text'])),
  )
}

/**
 * A change made in another window: stores `settings` (all of them; the rest
 * take their defaults) with the next revision and sends the page the event
 * Rust would.
 */
export function changeEditorSettingsElsewhere(page: Page, settings: Record<string, unknown>) {
  return page.evaluate((stored) => {
    const w = globalThis as unknown as TestWindow & {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.devotEditorSettings = stored
    w.devotEditorRevision = (w.devotEditorRevision ?? 0) + 1
    const detail = { revision: w.devotEditorRevision, settings: stored }
    w.dispatchEvent(new w.CustomEvent('devot:editor-settings-changed', { detail }))
  }, settings)
}

/** The keyboard shortcut changes a page has stored (what Rust would hold). */
export function storedShortcuts(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).devotShortcutOverrides ?? {})
}

/**
 * A change made in another window (Settings): stores `overrides` (all of
 * them) with the next revision and sends the page the event Rust would.
 */
export function changeShortcutsElsewhere(page: Page, overrides: Record<string, string[]>) {
  return page.evaluate((stored) => {
    const w = globalThis as unknown as TestWindow & {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.devotShortcutOverrides = stored
    w.devotShortcutRevision = (w.devotShortcutRevision ?? 0) + 1
    const detail = { revision: w.devotShortcutRevision, overrides: stored }
    w.dispatchEvent(new w.CustomEvent('devot:keyboard-shortcuts-changed', { detail }))
  }, overrides)
}

/** Sends the page the mirror's status as Rust would after a change (from the other window). */
export function changeMirrorElsewhere(page: Page, change: Partial<MockMirror>) {
  return page.evaluate((next) => {
    const w = globalThis as unknown as TestWindow & {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    const mirror = (w.devotMirror ??= {
      revision: 0,
      generation: 0,
      folder: null,
      includeAttachments: true,
      paused: null,
      size: 0,
      kept: [],
      keptCount: 0,
    })
    Object.assign(mirror, next)
    mirror.revision += 1
    const { manifest, ...detail } = mirror
    void manifest
    w.dispatchEvent(new w.CustomEvent('devot:mirror-changed', { detail }))
  }, change)
}

const menuPopups = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as TestWindow).devotIpcCalls.filter(
        (c) => c.cmd === 'plugin:menu|popup',
      ).length,
  )

/**
 * Opens the open note's More menu (the ellipsis at the end of the editor's
 * toolbar) and resolves to its items, as `shownMenu` lists them. With
 * `keepFocus`, the button is clicked without taking the keyboard.
 */
export async function openNoteMore(
  page: Page,
  options: { keepFocus?: boolean } = {},
): Promise<string[]> {
  const before = await menuPopups(page)
  const more = page.getByRole('button', { name: 'More', exact: true })
  if (options.keepFocus) await more.dispatchEvent('click')
  else await more.click()
  await expect.poll(() => menuPopups(page)).toBe(before + 1)
  return shownMenu(page)
}

/** Picks an item of the open note's More menu. */
export async function pickNoteMore(page: Page, label: string): Promise<void> {
  await openNoteMore(page)
  await pickMenuItem(page, label)
}

/** Whether the open note is pinned: its More menu offers Unpin. Leaves the keyboard alone. */
export async function openNotePinned(page: Page): Promise<boolean> {
  const items = await openNoteMore(page, { keepFocus: true })
  return items.some((line) => line === 'Unpin' || line.startsWith('Unpin '))
}

/** The status pop-up button under the open note's title (or in `scope`, the selection summary). */
export function statusPicker(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: 'Status', exact: true })
}

/** The notebook pop-up button under the open note's title. */
export function bookPicker(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: 'Notebook', exact: true })
}

/** Opens the status pop-over and picks `label` (None, Active, On Hold, Completed, Dropped). */
export async function pickStatus(scope: Page | Locator, label: string): Promise<void> {
  await statusPicker(scope).click()
  await scope
    .getByRole('listbox', { name: 'Status' })
    .getByRole('option', { name: label, exact: true })
    .click()
}

/** Opens the notebook pop-over and picks the notebook named `label` (or No Notebook). */
export async function pickBook(scope: Page | Locator, label: string): Promise<void> {
  await bookPicker(scope).click()
  await scope
    .getByRole('listbox', { name: 'Notebook' })
    .getByRole('option', { name: label, exact: true })
    .click()
}
