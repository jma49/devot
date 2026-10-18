// Native context menus (Tauri menu API). Each kind of menu is built once per
// window from a table of entries (again after the keys in effect change);
// before it pops up, the menu shows, hides, relabels and checks its items
// for the thing that was right-clicked.
import type { CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import { useCallback, useEffect, useRef } from 'react'
import { shortcutAccelerator } from './commands/keys'
import { command, commandKeys, type CommandId } from './commands/registry'
import { currentKeymap } from './commands/shortcutSettings'
import { t, type MessageKey } from './i18n'

export interface MenuEntry<A extends string, T> {
  action: A
  /** A fixed label, or one chosen for the target. */
  label: MessageKey | ((target: T) => MessageKey)
  /** Shown in the menu; the menu's owner handles the key itself. */
  accelerator?: string
  /** Whether the item shows for the target; it always shows without this. */
  shown?: (target: T) => boolean
  /** Makes the item a checkbox: whether it is checked for the target. */
  checked?: (target: T) => boolean
  /**
   * Makes the item a submenu of these entries (its own `action` only names
   * it). Submenu entries always show; they may be relabelled and checked.
   */
  submenu?: readonly MenuEntry<A, T>[]
  /**
   * Makes the item a system item (Cut, Copy, Paste, Select All): the system
   * titles it and acts on the web view itself, so a pick never reaches the
   * menu's owner and `label` is not shown.
   */
  predefined?: PredefinedKind
  /** The item's text for the target, in place of `label` (already translated). */
  text?: (target: T) => string
}

/** The system items a menu may hold (Tauri's predefined menu items). */
export type PredefinedKind = 'Cut' | 'Copy' | 'Paste' | 'SelectAll'

/** What `commandEntry` may add to a command's entry. */
export type CommandEntryOptions<A extends string, T> = Pick<
  MenuEntry<A, T>,
  'shown' | 'checked'
> & {
  label?: MenuEntry<A, T>['label']
}

/**
 * The entry for a registry command: the command's label and its first key in
 * effect as the accelerator (read each time, so it follows the user's
 * changes). `more` adds rules, or a label chosen per target.
 */
export function commandEntry<A extends string, T>(
  action: A,
  id: CommandId,
  more: CommandEntryOptions<A, T> = {},
): MenuEntry<A, T> {
  const entry: MenuEntry<A, T> = { action, label: command(id).label, ...more }
  return Object.defineProperty(entry, 'accelerator', {
    enumerable: true,
    get: () => {
      const key = commandKeys(id)[0]
      return key === undefined ? undefined : shortcutAccelerator(key)
    },
  })
}

/** A menu's entries, group by group; separators go between the groups. */
export type MenuGroups<A extends string, T> = readonly (readonly MenuEntry<A, T>[])[]

/** The entries shown for a target, group by group; empty groups are left out. */
export function shownGroups<A extends string, T>(
  groups: MenuGroups<A, T>,
  target: T,
): MenuEntry<A, T>[][] {
  return groups
    .map((group) => group.filter((entry) => entry.shown?.(target) ?? true))
    .filter((group) => group.length > 0)
}

const labelFor = <A extends string, T>(entry: MenuEntry<A, T>, target: T): string =>
  entry.text?.(target) ?? t(typeof entry.label === 'function' ? entry.label(target) : entry.label)

export interface NativeItemOptions {
  id: string
  text: string
  accelerator?: string
  /** Set for a check item. */
  checked?: boolean
  action: () => void
}

export interface NativeItem {
  setText?(text: string): Promise<void>
  setChecked?(checked: boolean): Promise<void>
}

/** A point in the window, in CSS pixels from its top-left corner. */
export interface MenuPoint {
  x: number
  y: number
}

export interface NativeMenu {
  insert(items: NativeItem[], position: number): Promise<void>
  remove(item: NativeItem): Promise<void>
  /** Pops up at `at`, or at the pointer; resolves once the menu has closed. */
  popup(at?: MenuPoint): Promise<void>
  close(): Promise<void>
}

/** The native calls a context menu needs (the Tauri menu API in the app). */
export interface NativeMenuApi {
  item(options: NativeItemOptions): Promise<NativeItem>
  separator(): Promise<NativeItem>
  predefined(kind: PredefinedKind): Promise<NativeItem>
  submenu(options: { id: string; text: string; items: NativeItem[] }): Promise<NativeItem>
  menu(items: NativeItem[]): Promise<NativeMenu>
}

export interface ContextMenu<T> {
  /** Updates the items for `target` and pops the menu up at `at`, or at the pointer. */
  popup(target: T, at?: MenuPoint): Promise<void>
  close(): Promise<void>
}

/**
 * Builds a context menu once, with every item it can show; `onPick` gets the
 * action of the item clicked. Item IDs are `devot.<name>.<action>`.
 */
export async function createContextMenu<A extends string, T>(
  name: string,
  groups: MenuGroups<A, T>,
  onPick: (action: A) => void,
  api: NativeMenuApi,
  first: T,
): Promise<ContextMenu<T>> {
  interface Slot {
    entry: MenuEntry<A, T>
    item: NativeItem
    text: string
    checked: boolean | undefined
  }
  // Submenu items: relabelled and checked with the rest, always shown.
  const nested: Slot[] = []
  const build = async (entry: MenuEntry<A, T>): Promise<Slot> => {
    const text = labelFor(entry, first)
    const id = `devot.${name}.${entry.action}`
    if (entry.predefined) {
      // The system's own title and action; there is nothing to relabel.
      return { entry, item: await api.predefined(entry.predefined), text, checked: undefined }
    }
    if (entry.submenu) {
      const children = await Promise.all(entry.submenu.map(build))
      nested.push(...children)
      const item = await api.submenu({ id, text, items: children.map((c) => c.item) })
      return { entry, item, text, checked: undefined }
    }
    const checked = entry.checked?.(first)
    const slot: Omit<Slot, 'item'> = { entry, text, checked }
    const item = await api.item({
      id,
      text,
      ...(entry.accelerator ? { accelerator: entry.accelerator } : {}),
      ...(checked === undefined ? {} : { checked }),
      action: () => {
        // The system may flip a check item when it is clicked: set it
        // again next time, whatever the target.
        slot.checked = undefined
        onPick(entry.action)
      },
    })
    return Object.assign(slot, { item })
  }
  // Created side by side, in menu order.
  const slots: Slot[][] = await Promise.all(groups.map((group) => Promise.all(group.map(build))))
  // `separators[i]` goes between group i and group i + 1.
  const separators = await Promise.all(groups.slice(1).map(() => api.separator()))

  /** The items the menu shows for a target, separators included, in order. */
  const layout = (target: T): NativeItem[] => {
    const out: NativeItem[] = []
    slots.forEach((group, i) => {
      const shown = group.filter((slot) => slot.entry.shown?.(target) ?? true)
      if (shown.length === 0) return
      const separator = separators[i - 1]
      if (out.length > 0 && separator) out.push(separator)
      out.push(...shown.map((slot) => slot.item))
    })
    return out
  }

  let current = layout(first)
  const menu = await api.menu(current)

  return {
    async popup(target, at) {
      const next = layout(target)
      // Both lists keep the same order, so removing what goes and inserting
      // what comes, front to back, gives the next layout.
      for (const item of current) if (!next.includes(item)) await menu.remove(item)
      current = current.filter((item) => next.includes(item))
      for (const [i, item] of next.entries()) {
        if (current[i] === item) continue
        await menu.insert([item], i)
        current.splice(i, 0, item)
      }
      for (const slot of [...slots.flat(), ...nested]) {
        if (slot.entry.predefined) continue
        const text = labelFor(slot.entry, target)
        if (text !== slot.text) {
          await slot.item.setText?.(text)
          slot.text = text
        }
        const checked = slot.entry.checked?.(target)
        if (checked !== undefined && checked !== slot.checked) {
          await slot.item.setChecked?.(checked)
          slot.checked = checked
        }
      }
      await menu.popup(at)
    },
    close: () => menu.close(),
  }
}

type TauriItem = MenuItem | CheckMenuItem | PredefinedMenuItem | Submenu

/** The Tauri menu API, loaded when the first menu is needed. */
async function tauriMenus(): Promise<NativeMenuApi> {
  const [native, { LogicalPosition }] = await Promise.all([
    import('@tauri-apps/api/menu'),
    import('@tauri-apps/api/dpi'),
  ])
  return {
    item: ({ checked, ...options }) =>
      checked === undefined
        ? native.MenuItem.new(options)
        : native.CheckMenuItem.new({ ...options, checked }),
    separator: () => native.PredefinedMenuItem.new({ item: 'Separator' }),
    predefined: (kind) => native.PredefinedMenuItem.new({ item: kind }),
    submenu: ({ items, ...options }) =>
      native.Submenu.new({ ...options, items: items as TauriItem[] }),
    async menu(items) {
      const menu = await native.Menu.new({ items: items as TauriItem[] })
      return {
        insert: (more, position) => menu.insert(more as TauriItem[], position),
        remove: (item) => menu.remove(item as TauriItem),
        popup: (at) => (at ? menu.popup(new LogicalPosition(at.x, at.y)) : menu.popup()),
        close: () => menu.close(),
      }
    },
  }
}

/**
 * A context menu for this window, built on first use and kept for the
 * window's life. Returns `show(target, at?)`, which pops the menu up at `at`
 * (or at the pointer) and resolves once it has closed; a picked item calls
 * `onPick` with that target.
 */
export function useContextMenu<A extends string, T>(
  name: string,
  groups: MenuGroups<A, T>,
  onPick: (action: A, target: T) => void,
) {
  // The menu's name and entries are fixed for the window's life.
  const spec = useRef({ name, groups })
  const pick = useRef(onPick)
  useEffect(() => {
    pick.current = onPick
  }, [onPick])
  const target = useRef<{ value: T }>(undefined)
  const menu = useRef<Promise<ContextMenu<T>>>(undefined)
  /** The keys the menu was built with; changed keys build it afresh. */
  const builtWith = useRef<unknown>(undefined)
  useEffect(
    () => () => {
      void menu.current?.then((m) => m.close()).catch(() => {})
    },
    [],
  )
  return useCallback(async (next: T, at?: MenuPoint) => {
    target.current = { value: next }
    if (menu.current && builtWith.current !== currentKeymap()) {
      const old = menu.current
      menu.current = undefined
      void old.then((m) => m.close()).catch(() => {})
    }
    builtWith.current = currentKeymap()
    menu.current ??= tauriMenus().then((api) =>
      createContextMenu(
        spec.current.name,
        spec.current.groups,
        (action) => {
          if (target.current) pick.current(action, target.current.value)
        },
        api,
        next,
      ),
    )
    const built = menu.current
    try {
      await (await built).popup(next, at)
    } catch {
      // Build it afresh next time; release what was built.
      menu.current = undefined
      void built.then((m) => m.close()).catch(() => {})
      console.warn('W_CONTEXT_MENU_FAILED', spec.current.name)
    }
  }, [])
}
