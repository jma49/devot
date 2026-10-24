import { describe, expect, it } from 'vitest'
import { hears, MAIN_WINDOW, noteWindowLabel, relayGate } from './noteRelay'
import { fromWireRelay, toWireRelay } from './noteRelayWire'
import { fromBase64, toBase64 } from './storage/wire'

const ID = '0192a6f0-0000-7000-8000-000000000001'
const OTHER = '0192a6f0-0000-7000-8000-000000000002'

describe('the note relay between windows', () => {
  it('codes Yjs data as base64 and leaves the other messages as they are', () => {
    const update = { kind: 'update' as const, noteId: ID, data: Uint8Array.of(1, 2, 3, 250) }
    const wire = toWireRelay(update, toBase64)
    expect(wire).toEqual({ kind: 'update', noteId: ID, data: 'AQID+g==' })
    expect(fromWireRelay(wire, fromBase64)).toEqual(update)
    const title = { kind: 'title' as const, noteId: ID, title: 'Plan', hlc: 'h' }
    expect(toWireRelay(title, toBase64)).toEqual(title)
    expect(fromWireRelay(title, fromBase64)).toEqual(title)
  })

  it('reaches every main window and the note’s own window, as Rust routes it', () => {
    expect(hears(MAIN_WINDOW, ID)).toBe(true)
    expect(hears('main-2', ID)).toBe(true)
    expect(hears('main-2x', ID)).toBe(false)
    expect(hears(noteWindowLabel(ID), ID)).toBe(true)
    expect(hears(noteWindowLabel(OTHER), ID)).toBe(false)
    expect(hears('settings', ID)).toBe(false)
  })

  it('sends a main window’s changes only for notes another window has spoken of', () => {
    const gate = relayGate(false)
    const update = { kind: 'update' as const, noteId: ID, data: 'AAA=' }
    expect(gate.allows(update)).toBe(false)
    expect(gate.allows({ kind: 'want', noteId: ID, data: 'AAA=' })).toBe(true)
    gate.heard(ID)
    expect(gate.allows(update)).toBe(true)
    expect(gate.allows({ ...update, noteId: OTHER })).toBe(false)
    expect(relayGate(true).allows({ ...update, noteId: OTHER })).toBe(true)
  })
})
