import { describe, expect, it } from 'vitest'
import {
  createContextMenu,
  shownGroups,
  type MenuGroups,
  type NativeItemOptions,
  type NativeItem,
  type NativeMenuApi,
} from './contextMenu'

interface Target {
  name: string
  nested: boolean
  flagged: boolean
}

type Action = 'open' | 'flag' | 'lift' | 'drop'

const GROUPS: MenuGroups<Action, Target> = [
  [{ action: 'open', label: 'book.new' }],
  [
    {
      action: 'flag',
      label: (t) => (t.flagged ? 'note.unpin' : 'note.pin'),
      accelerator: 'P',
    },
    { action: 'lift', label: 'sidebar.allNotes', shown: (t) => t.nested },
  ],
  [{ action: 'drop', label: 'sidebar.trash', checked: (t) => t.flagged }],
]

const target = (over: Partial<Target> = {}): Target => ({
  name: 'Work',
  nested: false,
  flagged: false,
  ...over,
})

describe('shownGroups', () => {
  it('keeps the items shown for the target, group by group', () => {
    const actions = (t: Target) =>
      shownGroups(GROUPS, t).map((group) => group.map((entry) => entry.action))
    expect(actions(target())).toEqual([['open'], ['flag'], ['drop']])
    expect(actions(target({ nested: true }))).toEqual([['open'], ['flag', 'lift'], ['drop']])
  })

  it('drops a group with nothing shown', () => {
    const groups: MenuGroups<Action, Target> = [
      [{ action: 'open', label: 'book.new' }],
      [{ action: 'lift', label: 'sidebar.allNotes', shown: (t) => t.nested }],
      [{ action: 'drop', label: 'sidebar.trash' }],
    ]
    expect(shownGroups(groups, target()).map((g) => g.map((e) => e.action))).toEqual([
      ['open'],
      ['drop'],
    ])
  })
})

/** A native menu stand-in: items are plain objects, the menu a list of them. */
function fakeApi() {
  interface Item {
    kind: 'item' | 'separator' | 'submenu' | 'predefined'
    options?: NativeItemOptions
    text?: string
    checked?: boolean
    items?: Item[]
  }
  const calls: string[] = []
  const menus: Item[][] = []
  const api: NativeMenuApi = {
    async item(options) {
      const item: Item = { kind: 'item', options, text: options.text }
      if (options.checked !== undefined) item.checked = options.checked
      return Object.assign(item, {
        async setText(text: string) {
          calls.push(`setText ${text}`)
          item.text = text
        },
        async setChecked(checked: boolean) {
          calls.push(`setChecked ${String(checked)}`)
          item.checked = checked
        },
      })
    },
    async separator() {
      return { kind: 'separator' } satisfies Item as unknown as NativeItem
    },
    async predefined(kind) {
      calls.push(`predefined ${kind}`)
      return { kind: 'predefined', text: kind } satisfies Item as unknown as NativeItem
    },
    async submenu({ id, text, items }) {
      const item: Item = { kind: 'submenu', text, items: items as Item[] }
      return Object.assign(item, {
        id,
        async setText(next: string) {
          calls.push(`setText ${next}`)
          item.text = next
        },
      })
    },
    async menu(items) {
      const list = [...(items as Item[])]
      menus.push(list)
      return {
        async insert(more, position) {
          calls.push(`insert ${position}`)
          list.splice(position, 0, ...(more as Item[]))
        },
        async remove(item) {
          calls.push('remove')
          list.splice(list.indexOf(item as Item), 1)
        },
        async popup(at) {
          calls.push(at ? `popup at ${at.x},${at.y}` : 'popup')
        },
        async close() {
          calls.push('close')
        },
      }
    },
  }
  /**
   * The menu as shown: one line per item, `---` for a separator; a
   * submenu's items follow it, indented.
   */
  const lines = (items: Item[], indent = ''): string[] =>
    items.flatMap((item) => {
      if (item.kind === 'separator') return ['---']
      if (item.kind === 'submenu') {
        return [`${indent}${item.text ?? ''} >`, ...lines(item.items ?? [], `${indent}  `)]
      }
      const accelerator = item.options?.accelerator ? ` ${item.options.accelerator}` : ''
      const check = item.checked === undefined ? '' : item.checked ? ' [x]' : ' [ ]'
      return [`${indent}${item.text ?? ''}${accelerator}${check}`]
    })
  const shown = () => lines(menus[0] ?? [])
  /** Clicks the item with this ID, in the menu or a submenu. */
  const click = (id: string) => {
    const all = (menus[0] ?? []).flatMap((i) => [i, ...(i.items ?? [])])
    const item = all.find((i) => i.options?.id === id)
    if (!item?.options) throw new Error(`no item ${id}`)
    item.options.action()
  }
  return { api, calls, menus, shown, click }
}

describe('createContextMenu', () => {
  it("builds one menu with the target's items, labels and checks", async () => {
    const fake = fakeApi()
    const menu = await createContextMenu('test', GROUPS, () => {}, fake.api, target())
    await menu.popup(target())
    expect(fake.menus).toHaveLength(1)
    expect(fake.shown()).toEqual(['New Notebook', '---', 'Pin to Top P', '---', 'Trash [ ]'])
    expect(fake.calls).toEqual(['popup'])
  })

  it('shows, hides, relabels and checks items for each target in the same menu', async () => {
    const fake = fakeApi()
    const menu = await createContextMenu('test', GROUPS, () => {}, fake.api, target())
    await menu.popup(target({ nested: true, flagged: true }))
    expect(fake.shown()).toEqual([
      'New Notebook',
      '---',
      'Unpin P',
      'All Notes',
      '---',
      'Trash [x]',
    ])
    await menu.popup(target())
    expect(fake.shown()).toEqual(['New Notebook', '---', 'Pin to Top P', '---', 'Trash [ ]'])
    // Nothing is touched when the next target needs the same menu.
    fake.calls.length = 0
    await menu.popup(target({ name: 'Home' }))
    expect(fake.calls).toEqual(['popup'])
    expect(fake.menus).toHaveLength(1)
  })

  it('pops up at a point in the window when given one, else at the pointer', async () => {
    const fake = fakeApi()
    const menu = await createContextMenu('test', GROUPS, () => {}, fake.api, target())
    await menu.popup(target(), { x: 12, y: 40 })
    await menu.popup(target())
    expect(fake.calls).toEqual(['popup at 12,40', 'popup'])
  })

  it('keeps separators between shown groups only', async () => {
    const fake = fakeApi()
    const groups: MenuGroups<Action, Target> = [
      [{ action: 'open', label: 'book.new', shown: (t) => t.nested }],
      [{ action: 'lift', label: 'sidebar.allNotes', shown: (t) => t.nested }],
      [{ action: 'drop', label: 'sidebar.trash' }],
    ]
    const menu = await createContextMenu('test', groups, () => {}, fake.api, target())
    await menu.popup(target())
    expect(fake.shown()).toEqual(['Trash'])
    await menu.popup(target({ nested: true }))
    expect(fake.shown()).toEqual(['New Notebook', '---', 'All Notes', '---', 'Trash'])
    await menu.popup(target())
    expect(fake.shown()).toEqual(['Trash'])
  })

  it('sets a check item again after a click, which the system may have flipped', async () => {
    const fake = fakeApi()
    const menu = await createContextMenu('test', GROUPS, () => {}, fake.api, target())
    await menu.popup(target())
    fake.click('devot.test.drop')
    fake.calls.length = 0
    await menu.popup(target({ name: 'Home' }))
    expect(fake.calls).toEqual(['setChecked false', 'popup'])
  })

  it('builds a submenu of check items, checked for each target', async () => {
    type Pick = 'name' | 'tint' | 'tint.none' | 'tint.red'
    interface Tinted {
      tint: 'red' | null
    }
    const groups: MenuGroups<Pick, Tinted> = [
      [
        { action: 'name', label: 'book.new' },
        {
          action: 'tint',
          label: 'tagMenu.color',
          submenu: [
            { action: 'tint.none', label: 'tagColor.none', checked: (t) => t.tint === null },
            { action: 'tint.red', label: 'tagColor.red', checked: (t) => t.tint === 'red' },
          ],
        },
      ],
    ]
    const fake = fakeApi()
    const picked: Pick[] = []
    const plain: Tinted = { tint: null }
    const menu = await createContextMenu('test', groups, (a) => picked.push(a), fake.api, plain)
    await menu.popup(plain)
    expect(fake.shown()).toEqual(['New Notebook', 'Colour >', '  None [x]', '  Red [ ]'])
    await menu.popup({ tint: 'red' })
    expect(fake.shown()).toEqual(['New Notebook', 'Colour >', '  None [ ]', '  Red [x]'])
    fake.click('devot.test.tint.none')
    expect(picked).toEqual(['tint.none'])
  })

  it('reports the action of the item clicked', async () => {
    const fake = fakeApi()
    const picked: Action[] = []
    const menu = await createContextMenu(
      'test',
      GROUPS,
      (a) => picked.push(a),
      fake.api,
      target({ nested: true }),
    )
    await menu.popup(target({ nested: true }))
    fake.click('devot.test.lift')
    fake.click('devot.test.drop')
    expect(picked).toEqual(['lift', 'drop'])
  })

  it('adds system items as they are and never relabels them', async () => {
    const fake = fakeApi()
    const groups: MenuGroups<Action, Target> = [
      [{ action: 'open', label: 'book.new', text: (t) => `Open ${t.name}` }],
      [
        { action: 'flag', label: 'book.new', predefined: 'Copy' },
        { action: 'lift', label: 'book.new', predefined: 'SelectAll', shown: (t) => t.nested },
      ],
    ]
    const picked: Action[] = []
    const menu = await createContextMenu('test', groups, (a) => picked.push(a), fake.api, target())
    await menu.popup(target())
    expect(fake.shown()).toEqual(['Open Work', '---', 'Copy'])
    await menu.popup(target({ name: 'Home', nested: true }))
    expect(fake.shown()).toEqual(['Open Home', '---', 'Copy', 'SelectAll'])
    expect(fake.calls.filter((c) => c.startsWith('setText'))).toEqual(['setText Open Home'])
    expect(picked).toEqual([])
  })
})
