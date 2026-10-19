import { describe, expect, it } from 'vitest'
import { closedDialogs, openedDialogs, type DialogRecord } from './dialogMotion'

interface Fake {
  name: string
  open: boolean
  connected: boolean
  children?: Fake[]
}

const dialog = (name: string, open = false, connected = false): Fake => ({ name, open, connected })
const isDialog = (node: unknown): node is Fake =>
  typeof node === 'object' && node !== null && 'open' in node
const dialogsIn = (node: unknown): Fake[] => {
  if (!isDialog(node)) return []
  return [node, ...(node.children ?? [])].filter((d) => d.open)
}
const stillOpen = (d: Fake) => d.connected && d.open
const closed = (records: DialogRecord[]) =>
  closedDialogs(records, isDialog, dialogsIn, stillOpen).map((d) => d.name)

const attribute = (target: Fake, oldValue: string | null): DialogRecord => ({
  type: 'attributes',
  target,
  oldValue,
  removed: [],
})
const removal = (...removed: Fake[]): DialogRecord => ({
  type: 'childList',
  target: null,
  oldValue: null,
  removed,
})

describe('the dialogs that closed', () => {
  it('finds a dialog that closed, once, whether or not it then left the page', () => {
    const d = dialog('confirm')
    expect(closed([attribute(d, ''), removal(d)])).toEqual(['confirm'])
  })

  it('finds an open dialog that left the page, inside what was removed too', () => {
    const inner = dialog('sheet', true)
    expect(closed([removal({ ...dialog('wrapper'), children: [inner] })])).toEqual(['sheet'])
    expect(closed([removal(dialog('palette', true))])).toEqual(['palette'])
  })

  it('leaves a dialog that opened, opened again or never was open', () => {
    expect(closed([attribute(dialog('opened', true, true), null)])).toEqual([])
    expect(closed([attribute(dialog('reopened', true, true), '')])).toEqual([])
    expect(closed([removal(dialog('shut'))])).toEqual([])
  })
})

const opened = (records: DialogRecord[]) =>
  openedDialogs(records, isDialog, dialogsIn, stillOpen).map((d) => d.name)
const addition = (...added: Fake[]): DialogRecord => ({
  type: 'childList',
  target: null,
  oldValue: null,
  removed: [],
  added,
})

describe('the dialogs that opened', () => {
  it('finds a dialog that opened, once, whether it was shown or added open', () => {
    const d = dialog('palette', true, true)
    expect(opened([addition(d), attribute(d, null)])).toEqual(['palette'])
  })

  it('finds an open dialog added inside a page part', () => {
    const inner = dialog('sheet', true, true)
    expect(opened([addition({ ...dialog('wrapper'), children: [inner] })])).toEqual(['sheet'])
  })

  it('leaves a dialog that closed, or opened and closed again before it was seen', () => {
    expect(opened([attribute(dialog('closed'), '')])).toEqual([])
    expect(opened([attribute(dialog('flicker', false, true), null)])).toEqual([])
  })
})
