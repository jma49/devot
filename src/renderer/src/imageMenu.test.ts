import { describe, expect, it } from 'vitest'
import { createContextMenu, type NativeItem, type NativeMenuApi } from './contextMenu'
import {
  IMAGE_MENU,
  imageActionApplies,
  imageMenuHasItems,
  sizeOfAction,
  type ImageAction,
  type ImageMenuTarget,
} from './imageMenu'

/** The menu's lines for a target, with a submenu's items indented after it. */
async function shown(target: ImageMenuTarget) {
  interface Item {
    text: string
    checked?: boolean
    items?: Item[]
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
      return { text: '---' } satisfies Item as unknown as NativeItem
    },
    async submenu({ text, items }) {
      return { text, items: items as Item[] } satisfies Item as unknown as NativeItem
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
  const menu = await createContextMenu<ImageAction, ImageMenuTarget>(
    'image',
    IMAGE_MENU,
    () => {},
    api,
    target,
  )
  await menu.popup(target)
  const lines = (items: Item[], indent = ''): string[] =>
    items.flatMap((i) => {
      if (i.items) return [`${indent}${i.text} >`, ...lines(i.items, `${indent}  `)]
      const check = i.checked === undefined ? '' : i.checked ? ' [x]' : ' [ ]'
      return [`${indent}${i.text}${check}`]
    })
  return lines(top)
}

const source = { from: 0, to: 10, text: '![](x.png)' }

describe('IMAGE_MENU', () => {
  it('copies and saves an attachment and sets its size', async () => {
    expect(await shown({ fileId: 'f', source, size: 'half' })).toEqual([
      'Copy Image',
      'Save Image As…',
      '---',
      'Size >',
      '  Auto [ ]',
      '  Small [ ]',
      '  Half Width [x]',
      '  Full Width [ ]',
    ])
  })

  it('only sizes a remote image', async () => {
    expect(await shown({ fileId: null, source, size: 'auto' })).toEqual([
      'Size >',
      '  Auto [x]',
      '  Small [ ]',
      '  Half Width [ ]',
      '  Full Width [ ]',
    ])
  })

  it('has no Size submenu for an image whose size cannot be set', async () => {
    expect(await shown({ fileId: 'f', source: null, size: 'auto' })).toEqual([
      'Copy Image',
      'Save Image As…',
    ])
    expect(imageMenuHasItems({ fileId: null, source: null, size: 'auto' })).toBe(false)
    expect(imageMenuHasItems({ fileId: null, source, size: 'auto' })).toBe(true)
  })

  it('runs an action only where its item shows', () => {
    const remote: ImageMenuTarget = { fileId: null, source, size: 'auto' }
    const reference: ImageMenuTarget = { fileId: 'f', source: null, size: 'auto' }
    expect(imageActionApplies('copy', remote)).toBe(false)
    expect(imageActionApplies('size.half', remote)).toBe(true)
    expect(imageActionApplies('save', reference)).toBe(true)
    expect(imageActionApplies('size.half', reference)).toBe(false)
    expect(imageActionApplies('size', remote)).toBe(false)
  })

  it('names the size each item picks', () => {
    expect(sizeOfAction('size.small')).toBe('small')
    expect(sizeOfAction('size.auto')).toBe('auto')
    expect(sizeOfAction('copy')).toBeUndefined()
    expect(sizeOfAction('size')).toBeUndefined()
  })
})
