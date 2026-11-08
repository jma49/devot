// The core's relay messages as they cross between the worker, the page and Rust (noteRelay.ts): Yjs
// data as the base64 the worker codes, so the page passes it on without reading it.
import type { NoteRelayMessage, TakenIn } from '../../core'

export type WireRelay =
  | { kind: 'update'; noteId: string; data: string }
  | { kind: 'want'; noteId: string; data: string }
  | { kind: 'title'; noteId: string; title: string; hlc: string }
  | { kind: 'saved'; noteId: string; updatedAt: number; authored?: true }
  | { kind: 'gone'; noteId: string; purged: boolean }
  | { kind: 'back'; noteId: string }

/** What the worker sends the page on its own channel: a message for the other windows, or a change for this window's editor. */
export type RelayOut = { noteRelay: WireRelay } | { takenIn: TakenIn }

export function relayOutIn(data: unknown): WireRelay | undefined {
  if (typeof data !== 'object' || data === null || !('noteRelay' in data)) return undefined
  return data.noteRelay as WireRelay
}

export function takenInIn(data: unknown): TakenIn | undefined {
  if (typeof data !== 'object' || data === null || !('takenIn' in data)) return undefined
  return data.takenIn as TakenIn
}

export function toWireRelay(
  message: NoteRelayMessage,
  toBase64: (bytes: Uint8Array) => string,
): WireRelay {
  if (message.kind === 'update' || message.kind === 'want') {
    return { ...message, data: toBase64(message.data) }
  }
  return message
}

export function fromWireRelay(
  message: WireRelay,
  fromBase64: (text: string) => Uint8Array,
): NoteRelayMessage {
  if (message.kind === 'update' || message.kind === 'want') {
    return { ...message, data: fromBase64(message.data) }
  }
  return message
}

/**
 * Which of the core's messages to send. A note window always sends: another window shows its note. A
 * main window sends what it asks for (`want`), and the changes to a note once another window has
 * spoken of it (another main window shows the note and answered, say), so a window alone costs
 * nothing for each keystroke.
 */
export function relayGate(always: boolean) {
  const spoken = new Set<string>()
  return {
    heard: (noteId: string) => void spoken.add(noteId),
    allows: (message: { kind: string; noteId: string }) =>
      always || message.kind === 'want' || spoken.has(message.noteId),
  }
}

/** The worker's side of the relay: what `relayGate` lets through is coded and posted to the page; nothing else is coded at all. */
export function relayOut(
  post: (out: RelayOut) => void,
  toBase64: (bytes: Uint8Array) => string,
  always: boolean,
) {
  const gate = relayGate(always)
  return {
    send: (message: NoteRelayMessage) => {
      if (gate.allows(message)) post({ noteRelay: toWireRelay(message, toBase64) })
    },
    heard: gate.heard,
  }
}
