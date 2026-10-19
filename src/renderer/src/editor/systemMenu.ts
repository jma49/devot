// The editor's menu as Rust shows it (`editor_menu_popup`): the page lays
// out its items as for any context menu (`createContextMenu`), and Rust adds
// the system's spelling guesses for the word at the point, Writing Tools,
// Spelling and Grammar and Services, which the Tauri menu API cannot hold.
// The pick comes back as the answer: one of the page's items, or a guess.
import type { NativeItem, NativeItemOptions, NativeMenuApi, PredefinedKind } from '../contextMenu'
import { invoke } from '../ipc'

export type SystemMenuEntry =
  | { kind: 'item'; id: string; text: string; accelerator?: string; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'predefined'; item: PredefinedKind }
  | { kind: 'submenu'; id: string; text: string; items: SystemMenuEntry[] }

export type SystemMenuPick = { kind: 'item'; id: string } | { kind: 'guess'; text: string } | null

type Node =
  | (NativeItem & { kind: 'item'; options: NativeItemOptions })
  | (NativeItem & { kind: 'separator' })
  | (NativeItem & { kind: 'predefined'; item: PredefinedKind })
  | (NativeItem & { kind: 'submenu'; id: string; text: string; items: Node[] })

function entry(node: Node): SystemMenuEntry {
  switch (node.kind) {
    case 'item': {
      const { id, text, accelerator, checked } = node.options
      return {
        kind: 'item',
        id,
        text,
        ...(accelerator ? { accelerator } : {}),
        ...(checked === undefined ? {} : { checked }),
      }
    }
    case 'submenu':
      return { kind: 'submenu', id: node.id, text: node.text, items: node.items.map(entry) }
    case 'predefined':
      return { kind: 'predefined', item: node.item }
    default:
      return { kind: 'separator' }
  }
}

function find(nodes: readonly Node[], id: string): Node | undefined {
  for (const node of nodes) {
    if (node.kind === 'item' && node.options.id === id) return node
    if (node.kind === 'submenu') {
      const found = find(node.items, id)
      if (found) return found
    }
  }
  return undefined
}

export interface Spelling {
  word: () => string | null
  replace: (guess: string) => void
}

/**
 * Whether Rust can show the editor's menu: on macOS (the web view says so),
 * and in the UI tests, which answer for Rust. Elsewhere the Tauri menu API
 * shows it, without the system's items.
 */
export const systemMenusAvailable = (): boolean =>
  DEVOT_UI_TEST || /\bMac OS X\b/.test(navigator.userAgent)

export function systemMenus(spelling: Spelling): NativeMenuApi {
  return {
    item: async (options) => {
      const node: Extract<Node, { kind: 'item' }> = {
        kind: 'item',
        options: { ...options },
        setText: async (text) => {
          node.options.text = text
        },
        setChecked: async (checked) => {
          node.options.checked = checked
        },
      }
      return node
    },
    // A node is a NativeItem: it only lacks the optional setters.
    separator: async () => ({ kind: 'separator' }) satisfies Node as NativeItem,
    predefined: async (item) => ({ kind: 'predefined', item }) satisfies Node as NativeItem,
    submenu: async ({ id, text, items }) =>
      ({ kind: 'submenu', id, text, items: items as Node[] }) satisfies Node as NativeItem,
    async menu(items) {
      const shown = [...(items as Node[])]
      return {
        insert: async (more, position) => {
          shown.splice(position, 0, ...(more as Node[]))
        },
        remove: async (item) => {
          const at = shown.indexOf(item as Node)
          if (at >= 0) shown.splice(at, 1)
        },
        async popup(at) {
          const pick = await invoke<SystemMenuPick>('editor_menu_popup', {
            items: shown.map(entry),
            x: Math.max(0, at?.x ?? 0),
            y: Math.max(0, at?.y ?? 0),
            word: spelling.word(),
          })
          if (pick?.kind === 'guess') spelling.replace(pick.text)
          else if (pick?.kind === 'item') {
            const node = find(shown, pick.id)
            if (node?.kind === 'item') node.options.action()
          }
        },
        // Rust keeps nothing between menus.
        close: async () => {},
      }
    },
  }
}
