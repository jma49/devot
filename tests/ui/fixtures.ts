import { expect, test as base, type Locator, type Page } from '@playwright/test'

// A 1x1 black PNG: what `symbol_png` returns, at a smaller size.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

export interface IpcCall {
  cmd: string
  args: Record<string, unknown>
}

export interface MockMenu {
  kind: string
  options: {
    id?: string
    text?: string
    accelerator?: string
    checked?: boolean
    items?: [number, string][]
    item?: string
  }
  /** Messages on this channel are clicks on the item. */
  handler?: { onmessage: (id: unknown) => void }
}

export type EditorMenuEntry =
  | { kind: 'item'; id: string; text: string; accelerator?: string; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'predefined'; item: string }
  | { kind: 'submenu'; id: string; text: string; items: EditorMenuEntry[] }

/** The page globals these tests touch; this config has no DOM types. */
export interface TestWindow {
  devotIpcCalls: IpcCall[]
  devotIpcMocks?: Record<string, unknown>
  /** The label of the window this page stands for (`main-2` for a window File > New Window opened); `main` by default. */
  devotWindowLabel?: string
  devotMenus: Record<number, MockMenu>
  devotEditorMenu?: { items: EditorMenuEntry[]; answer: (pick: unknown) => void } | undefined
  /** Only the settings that were set; the rest are defaults. */
  devotEditorSettings?: Record<string, unknown>
  devotEditorRevision?: number
  devotShortcutOverrides?: Record<string, string[]>
  devotShortcutRevision?: number
  devotMirror?: MockMirror
  /** Next folder pick for `mirror_choose`: used at once when `empty`, else after `mirror_confirm`; none cancels. */
  devotMirrorPick?: { folder: string; name: string; empty: boolean } | null
  devotMirrorApplied?: { kind: string; id: string; path?: string | null; text?: string }[]
}

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
 * Every UI test runs with Object.prototype frozen (as the app does) and Tauri IPC mocked;
 * the `window.devot*` globals hold the mock state. Storage is the in-memory adapter (vite.ui-test.config.ts).
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await mockTauri(page)
    const rebundled: string[] = []
    page.on('console', (message) => {
      if (REBUNDLED.test(message.text())) rebundled.push(message.text())
    })
    await use(page)
    // Vite re-bundled late and reloaded the page under the test (`optimizeDeps.entries` in vite.config.ts lists them up front).
    if (rebundled.length > 0)
      throw new Error(`Vite re-bundled while the page was open: ${rebundled[0]}`)
  },
})

/** Resolves once `data-ready` is on `.window`; acting earlier can lose a key or event no listener heard yet. */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path)
  await appReady(page)
}

export async function openSettings(page: Page, tab: string): Promise<void> {
  await page.goto('/settings.html')
  await page.getByRole('tab', { name: tab, exact: true }).click()
}

export async function reloadApp(page: Page): Promise<void> {
  await page.reload()
  await appReady(page)
}

export function appReady(page: Page): Promise<void> {
  return page.locator('.window[data-ready]').waitFor()
}

/** What Vite's client logs when its pre-bundle changed under an open page. */
const REBUNDLED = /new dependencies optimized|optimized dependencies changed/

export async function mockTauri(page: Page): Promise<void> {
  await page.addInitScript((png) => {
    // As in the app: Tauri puts its IPC in the main frame only (plugins' frames never get it) and freezes Object.prototype there
    // before page scripts run.
    if ((globalThis as unknown as { top: unknown }).top !== globalThis) return
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
          const mock = w.devotIpcMocks?.[cmd]
          if (mock !== undefined) {
            if (typeof mock === 'object' && mock !== null && 'error' in mock) throw mock.error
            return typeof mock === 'function' ? (mock as (a: unknown) => unknown)(args) : mock
          }
          // One notebook, allowed: Integrations shows no prompt unless a test says otherwise.
          if (cmd === 'settings_ai_access_summary') return { notebooks: 1, allowed: 1 }

          // No link from another app waits at launch (deep-links.spec.ts), and no plugin is installed (plugins.ts).
          if (cmd === 'deep_link_take' || cmd === 'plugins_list') return []
          if (cmd === 'cli_tool_status') return { state: 'absent', path: '/usr/local/bin/devot' }
          if (cmd === 'http_api_get')
            return {
              enabled: false,
              port: 27484,
              scope: 'read',
              listening: null,
              problem: null,
              token: 'unset',
            }
          // This build gates nothing unless a test fakes a licence (licence.spec.ts).
          if (cmd === 'licence_get')
            return {
              gated: false,
              state: 'none',
              code: null,
              id: null,
              licensee: null,
              plan: null,
            }
          // Sync is off unless a test fakes it (sync-settings.spec.ts).
          if (cmd === 'sync_get')
            return {
              relayUrl: '',
              enabled: false,
              vault: false,
              enrolled: false,
              status: { state: 'off', lastSync: null, code: null, tooLarge: 0 },
            }
          if (cmd === 'sync_recovery_key') return null
          if (
            cmd === 'clipboard_write_text' ||
            cmd === 'clipboard_write_secret' ||
            cmd === 'usage_record' ||
            cmd === 'format_menu_set' ||
            cmd === 'sidebar_menu_set' ||
            cmd === 'command_menu_set' ||
            cmd === 'text_look_up' ||
            cmd === 'text_speak'
          )
            return null
          // Stays open until an item is picked or another menu opens.
          if (cmd === 'editor_menu_popup') {
            w.devotEditorMenu?.answer(null)
            return new Promise((answer) => {
              w.devotEditorMenu = { items: args['items'] as EditorMenuEntry[], answer }
            })
          }
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
          if (cmd === 'sidebar_material_sync')
            return (w.devotEditorSettings?.['sidebarMaterial'] ?? true) !== false
          // Follow the system unless a test chose otherwise, so the suite's emulated Reduce Motion stays in charge.
          if (cmd === 'editor_settings_get')
            return {
              revision: w.devotEditorRevision ?? 0,
              settings: { animations: 'system', ...w.devotEditorSettings },
            }
          if (cmd === 'editor_settings_set') {
            w.devotEditorSettings = { ...w.devotEditorSettings, ...(args['patch'] as object) }
            w.devotEditorRevision = (w.devotEditorRevision ?? 0) + 1
            const next = {
              revision: w.devotEditorRevision,
              settings: { animations: 'system', ...w.devotEditorSettings },
            }
            const win = globalThis as unknown as {
              dispatchEvent(e: unknown): void
              CustomEvent: new (t: string, init: { detail: unknown }) => unknown
            }
            win.dispatchEvent(
              new win.CustomEvent('devot:editor-settings-changed', { detail: next }),
            )
            return next
          }
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
        metadata: {
          currentWindow: {
            get label() {
              return w.devotWindowLabel ?? 'main'
            },
          },
        },
      },
    })
  }, PNG)
}

export { expect } from '@playwright/test'

export function symbolRequests(calls: IpcCall[]): string[] {
  return calls
    .filter((c) => c.cmd === 'symbol_png')
    .map((c) => `${String(c.args['name'])}@${String(c.args['pointSize'])}`)
}

/**
 * The native menu shown last, one line per item: label and accelerator, then `[x]`/`[ ]` for a check
 * item or `---` for a separator. A submenu shows as `<label> >`, its items after it indented two spaces.
 */
export async function shownMenu(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    const shown = w.devotIpcCalls.findLast(
      (c) => c.cmd === 'plugin:menu|popup' || c.cmd === 'editor_menu_popup',
    )
    if (shown?.cmd === 'editor_menu_popup') {
      // Rust adds the system's items (spelling, Writing Tools, Services).
      const system: Record<string, string> = { SelectAll: 'Select All' }
      const lines = (items: EditorMenuEntry[], indent: string): string[] =>
        items.flatMap((item) => {
          if (item.kind === 'separator') return ['---']
          if (item.kind === 'predefined') return [`${indent}${system[item.item] ?? item.item}`]
          if (item.kind === 'submenu') {
            return [`${indent}${item.text} >`, ...lines(item.items, `${indent}  `)]
          }
          const line = item.accelerator ? `${item.text} ${item.accelerator}` : item.text
          return [
            `${indent}${item.checked === undefined ? line : `${line} ${item.checked ? '[x]' : '[ ]'}`}`,
          ]
        })
      return lines(shown.args['items'] as EditorMenuEntry[], '')
    }
    const popup = shown
    const menu = popup ? w.devotMenus[popup.args['rid'] as number] : undefined
    const lines = (items: [number, string][], indent: string): string[] =>
      items.flatMap(([rid]) => {
        const item = w.devotMenus[rid]
        if (!item) return ['---']
        if (item.kind === 'Predefined') {
          // The system titles its own items.
          const system: Record<string, string> = { SelectAll: 'Select All' }
          const kind = item.options.item ?? 'Separator'
          return [kind === 'Separator' ? '---' : `${indent}${system[kind] ?? kind}`]
        }
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

export async function answerEditorMenu(page: Page, pick: unknown): Promise<void> {
  const answered = await page.evaluate((p) => {
    const w = globalThis as unknown as TestWindow
    const open = w.devotEditorMenu
    w.devotEditorMenu = undefined
    open?.answer(p)
    return open !== undefined
  }, pick)
  if (!answered) throw new Error('E_TEST_NO_EDITOR_MENU')
}

export async function pickMenuItem(page: Page, label: string, submenu?: string): Promise<void> {
  // The opening click returns before the app has built the menu: retry.
  const deadline = Date.now() + 5000
  while (!(await pickMenuItemNow(page, label, submenu))) {
    if (Date.now() > deadline) {
      throw new Error(`E_TEST_NO_MENU_ITEM ${submenu ? `${submenu} > ` : ''}${label}`)
    }
    await page.waitForTimeout(50)
  }
}

async function pickMenuItemNow(page: Page, label: string, submenu?: string): Promise<boolean> {
  return page.evaluate(
    ([text, parent]) => {
      const w = globalThis as unknown as TestWindow
      const shown = w.devotIpcCalls.findLast(
        (c) => c.cmd === 'plugin:menu|popup' || c.cmd === 'editor_menu_popup',
      )
      if (shown?.cmd === 'editor_menu_popup') {
        const open = w.devotEditorMenu
        if (!open) return false
        let items = open.items
        if (parent !== undefined) {
          const sub = items.find((i) => i.kind === 'submenu' && i.text === parent)
          items = sub?.kind === 'submenu' ? sub.items : []
        }
        const item = items.find((i) => i.kind === 'item' && i.text === text)
        if (item?.kind !== 'item') return false
        w.devotEditorMenu = undefined
        open.answer({ kind: 'item', id: item.id })
        return true
      }
      const popup = shown
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
}

export async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (globalThis as unknown as TestWindow).devotIpcCalls
      .filter((c) => c.cmd === 'clipboard_write_text')
      .map((c) => String(c.args['text'])),
  )
}

/** A change made in another window: stores all of `settings` with the next revision and sends the page Rust's event. */
export function changeEditorSettingsElsewhere(page: Page, settings: Record<string, unknown>) {
  return page.evaluate((stored) => {
    const w = globalThis as unknown as TestWindow & {
      dispatchEvent(e: unknown): void
      CustomEvent: new (t: string, init: { detail: unknown }) => unknown
    }
    w.devotEditorSettings = stored
    w.devotEditorRevision = (w.devotEditorRevision ?? 0) + 1
    const detail = {
      revision: w.devotEditorRevision,
      settings: { animations: 'system', ...stored },
    }
    w.dispatchEvent(new w.CustomEvent('devot:editor-settings-changed', { detail }))
  }, settings)
}

export function storedShortcuts(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).devotShortcutOverrides ?? {})
}

/** A change made in another window (Settings): stores all of `overrides` with the next revision and sends Rust's event. */
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

/** Opens the note's More menu and returns its items; `keepFocus` clicks the button without taking the keyboard. */
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

export async function pickNoteMore(page: Page, label: string): Promise<void> {
  await openNoteMore(page)
  await pickMenuItem(page, label)
}

/** Whether the note is pinned (its More menu offers Unpin); leaves the keyboard alone. */
export async function openNotePinned(page: Page): Promise<boolean> {
  const items = await openNoteMore(page, { keepFocus: true })
  return items.some((line) => line === 'Unpin' || line.startsWith('Unpin '))
}

export function statusPicker(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /^Status\b/ })
}

export function bookPicker(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /^Notebook\b/ })
}

export async function pickStatus(scope: Page | Locator, label: string): Promise<void> {
  await statusPicker(scope).click()
  await scope
    .getByRole('listbox', { name: 'Status' })
    .getByRole('option', { name: label, exact: true })
    .click()
}

export async function pickBook(scope: Page | Locator, label: string): Promise<void> {
  await bookPicker(scope).click()
  await scope
    .getByRole('listbox', { name: 'Notebook' })
    .getByRole('option', { name: label, exact: true })
    .click()
}

/** Computed colour as `rgb()`/`rgba()`: a token-derived colour (`color(from ...)`) comes back as `color(srgb r g b / a)`. */
export function paintedColour(css: string): string {
  const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(css)
  if (!srgb) return css
  const [r, g, b] = srgb.slice(1, 4).map((c) => Math.round(Number(c) * 255))
  const alpha = srgb[4] === undefined ? 1 : Math.round(Number(srgb[4]) * 1000) / 1000
  return alpha === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export async function paintedBackground(element: Locator): Promise<string> {
  return paintedColour(
    await element.evaluate((el) => {
      const sheet =
        el.matches('.list, .content, .settings-main') &&
        document.documentElement.dataset['sidebarMaterial'] === 'on'
          ? el.closest('.window, .settings')
          : null
      return sheet
        ? getComputedStyle(sheet, '::before').backgroundColor
        : getComputedStyle(el).backgroundColor
    }),
  )
}
