import { describe, expect, it, vi } from 'vitest'
import type { NoteRelayMessage } from '../../core'
import shared from '../../../tests/fixtures/note-relay.json'
import { hears, MAIN_WINDOW, noteWindowLabel } from './noteRelay'
import {
  fromWireRelay,
  relayOut,
  toWireRelay,
  type RelayOut,
  type WireRelay,
} from './noteRelayWire'
import { fromBase64, toBase64 } from './storage/wire'

const ID = '0192a6f0-0000-7000-8000-000000000001'
const OTHER = '0192a6f0-0000-7000-8000-000000000002'

/** What the page hands `note_relay_send`; `cargo test` reads the same file (note_relay.rs). */
const SHARED = shared.messages as WireRelay[]

/** At least one message of every kind, so a kind the core gains fails the type check until the fixture holds it. */
type EachKind = {
  [K in NoteRelayMessage['kind']]: readonly [
    Extract<NoteRelayMessage, { kind: K }>,
    ...Extract<NoteRelayMessage, { kind: K }>[],
  ]
}

describe('the note relay between windows', () => {
  it('sends every kind of message as the fixture Rust reads holds it, and reads it back', () => {
    const sent = {
      update: [{ kind: 'update', noteId: ID, data: Uint8Array.of(1, 2, 3, 250) }],
      want: [{ kind: 'want', noteId: ID, data: Uint8Array.of(0) }],
      title: [{ kind: 'title', noteId: ID, title: 'Plan', hlc: '0001728000000000-0000-node' }],
      saved: [
        { kind: 'saved', noteId: ID, updatedAt: 1728000000000 },
        { kind: 'saved', noteId: ID, updatedAt: 1728000000000, authored: true },
      ],
      gone: [
        { kind: 'gone', noteId: ID, purged: false },
        { kind: 'gone', noteId: ID, purged: true },
      ],
      back: [{ kind: 'back', noteId: ID }],
    } satisfies EachKind
    const every: NoteRelayMessage[] = Object.values(sent).flat()
    expect(every.map((message) => toWireRelay(message, toBase64))).toStrictEqual(SHARED)
    expect(SHARED.map((message) => fromWireRelay(message, fromBase64))).toStrictEqual(every)
  })

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

  it('posts no change of a note no other window has spoken of, and codes nothing for it', () => {
    const posted: RelayOut[] = []
    const code = vi.fn<typeof toBase64>(toBase64)
    const out = relayOut((message) => posted.push(message), code, false)
    const update = { kind: 'update' as const, noteId: ID, data: Uint8Array.of(1) }
    out.send(update)
    out.send({ kind: 'saved', noteId: ID, updatedAt: 1 })
    expect(posted).toEqual([])
    expect(code).not.toHaveBeenCalled()
    out.send({ kind: 'want', noteId: ID, data: Uint8Array.of(2) })
    expect(posted).toEqual([{ noteRelay: { kind: 'want', noteId: ID, data: 'Ag==' } }])
    out.heard(ID)
    out.send(update)
    out.send({ ...update, noteId: OTHER })
    expect(posted.slice(1)).toEqual([{ noteRelay: { kind: 'update', noteId: ID, data: 'AQ==' } }])
  })

  it('posts every change of a note window, which another window always shows', () => {
    const posted: RelayOut[] = []
    const out = relayOut((message) => posted.push(message), toBase64, true)
    out.send({ kind: 'update', noteId: OTHER, data: Uint8Array.of(1) })
    expect(posted).toEqual([{ noteRelay: { kind: 'update', noteId: OTHER, data: 'AQ==' } }])
  })
})
