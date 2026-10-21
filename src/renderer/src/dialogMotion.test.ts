import { describe, expect, it } from 'vitest'
import {
  closedDialogs,
  dimAt,
  openedDialogs,
  type DialogRecord,
  type DimFade,
} from './dialogMotion'

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

describe('how dark a closing dialog leaves its dim', () => {
  const linear = (ms: number, fade: DimFade) => Math.min(Math.max(ms / fade.duration, 0), 1)
  const fade = (from: number, start: number | null = 1000): DimFade => ({
    start,
    keyframes: [{ opacity: String(from), easing: 'linear' }, { opacity: '1' }],
    duration: 2000,
  })

  it('a dialog closed partway through its dim fading in leaves the dim where it was drawn', () => {
    expect(dimAt(fade(0), 1300, linear)).toBeCloseTo(0.15)
  })

  it('a dialog that took over a fading dim leaves it from where the takeover had brought it', () => {
    expect(dimAt(fade(0.4), 1000, linear)).toBeCloseTo(0.4)
    expect(dimAt(fade(0.4), 2000, linear)).toBeCloseTo(0.7)
  })

  it('rises with the clock, however far apart the frames, and stops at full', () => {
    const at = [1000, 1016, 1500, 2990, 2991, 3000, 9000].map((t) => dimAt(fade(0.2), t, linear))
    at.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(at[i - 1] ?? 0))
    expect(at.at(-1)).toBe(1)
  })

  it('stays at the first keyframe before its fade has begun, and is full without a fade', () => {
    expect(dimAt(fade(0.3, null), 5000, linear)).toBe(0.3)
    expect(dimAt(undefined, 5000, linear)).toBe(1)
    expect(dimAt({ ...fade(0), duration: Infinity }, 5000, linear)).toBe(1)
  })
})
