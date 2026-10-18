// A fake native menu API for context-menu tests: builds a menu from entries
// as the app does and reports what it would show (for tests only).
import {
  createContextMenu,
  type MenuGroups,
  type NativeItem,
  type NativeMenuApi,
} from './contextMenu'

interface Item {
  text: string
  id: string
  checked?: boolean
  accelerator?: string
  items?: Item[]
  action?: () => void
}

/** The menu's lines for a target ("---" between groups), and a way to click an item by ID. */
export async function menuLines<A extends string, T>(
  name: string,
  groups: MenuGroups<A, T>,
  target: T,
  pick: (action: A) => void = () => {},
) {
  const top: Item[] = []
  const api: NativeMenuApi = {
    async item(options) {
      const item: Item = { ...options }
      return Object.assign(item, {
        async setChecked(checked: boolean) {
          item.checked = checked
        },
        async setText(text: string) {
          item.text = text
        },
      })
    },
    async separator() {
      return { text: '---', id: '' } satisfies Item as unknown as NativeItem
    },
    async predefined(kind) {
      return { text: kind, id: '' } satisfies Item as unknown as NativeItem
    },
    async submenu({ id, text, items }) {
      return { id, text, items: items as Item[] } satisfies Item as unknown as NativeItem
    },
    async menu(items) {
      top.push(...(items as Item[]))
      return {
        insert: async () => {},
        remove: async () => {},
        popup: async () => {},
        close: async () => {},
      }
    },
  }
  const menu = await createContextMenu(name, groups, pick, api, target)
  await menu.popup(target)
  const lines = top.map((i) => {
    if (i.text === '---') return '---'
    const check = i.checked === undefined ? '' : i.checked ? ' [x]' : ' [ ]'
    return `${i.text}${i.accelerator ? ` ${i.accelerator}` : ''}${check}`
  })
  const click = (id: string) => top.find((i) => i.id === id)?.action?.()
  return { lines, click }
}
