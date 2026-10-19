import { describe, expect, it } from 'vitest'
import { TAG_COLORS } from '../../core/storage'
import { createContextMenu, type NativeItem, type NativeMenuApi } from './contextMenu'
import { TAG_MENU, colorOfAction, type TagAction, type TagMenuTarget } from './tagMenu'

async function shown(target: TagMenuTarget, pick: (a: TagAction) => void = () => {}) {
  interface Item {
    text: string
    id: string
    checked?: boolean
    accelerator?: string
    items?: Item[]
    action?: () => void
  }
  const top: Item[] = []
  const api: NativeMenuApi = {
    async item(options) {
      const item: Item = { ...options }
      return Object.assign(item, {
        async setChecked(checked: boolean) {
          item.checked = checked
        },
      })
    },
    async separator() {
      return { text: '---', id: '' } satisfies Item as unknown as NativeItem
    },
    async predefined(kind) {
      return { text: kind } as unknown as NativeItem
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
  const menu = await createContextMenu('tag', TAG_MENU, pick, api, target)
  await menu.popup(target)
  const lines = (items: Item[], indent = ''): string[] =>
    items.flatMap((i) => {
      if (i.items) return [`${indent}${i.text} >`, ...lines(i.items, `${indent}  `)]
      const check = i.checked === undefined ? '' : i.checked ? ' [x]' : ' [ ]'
      return [`${indent}${i.text}${i.accelerator ? ` ${i.accelerator}` : ''}${check}`]
    })
  const click = (id: string) =>
    top
      .flatMap((i) => [i, ...(i.items ?? [])])
      .find((i) => i.id === id)
      ?.action?.()
  return { lines: lines(top), click }
}

describe('TAG_MENU', () => {
  it('shows Tag Settings, the Colour submenu, Filter by Tag, Copy Tag ID and Delete Tag', async () => {
    const { lines } = await shown({ id: 't', color: null, filtered: false })
    expect(lines).toEqual([
      'Tag Settings\u2026',
      'Colour >',
      '  None [x]',
      '  Red [ ]',
      '  Orange [ ]',
      '  Yellow [ ]',
      '  Green [ ]',
      '  Blue [ ]',
      '  Purple [ ]',
      '  Pink [ ]',
      '  Grey [ ]',
      '---',
      'Filter by Tag [ ]',
      '---',
      'Copy Tag ID',
      '---',
      'Delete Tag Backspace',
    ])
  })

  it("checks the tag's colour and whether the list is filtered by it", async () => {
    const { lines } = await shown({ id: 't', color: 'purple', filtered: true })
    expect(lines).toContain('  Purple [x]')
    expect(lines).toContain('  None [ ]')
    expect(lines).toContain('Filter by Tag [x]')
  })

  it('leaves Delete Tag out in a workspace', async () => {
    const { lines } = await shown({ id: 't', color: null, filtered: false, inWorkspace: true })
    expect(lines.slice(-2)).toEqual(['---', 'Copy Tag ID'])
    expect(lines.some((line) => line.startsWith('Delete Tag'))).toBe(false)
  })

  it('has one colour item per palette colour, each picking its colour', async () => {
    const picked: TagAction[] = []
    const { click } = await shown({ id: 't', color: null, filtered: false }, (a) => picked.push(a))
    click('devot.tag.color.none')
    for (const color of TAG_COLORS) click(`devot.tag.color.${color}`)
    expect(picked.map(colorOfAction)).toEqual([null, ...TAG_COLORS])
    expect(colorOfAction('rename')).toBeUndefined()
    expect(colorOfAction('color')).toBeUndefined()
  })
})
