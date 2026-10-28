// The core's relay messages as they cross between the worker, the page and Rust (noteRelay.ts): Yjs
// data as the base64 the worker codes, so the page passes it on without reading it.
import type { NoteRelayMessage, TakenIn } from '../../core'

export type WireRelay =
  | { kind: 'update'; noteId: string; data: string }
  | { kind: 'want'; noteId: string; data: string }
  | { kind: 'title'; noteId: string; title: string; hlc: string }
  | { kind: 'saved'; noteId: string; updatedAt: number }
  | { kind: 'gone'; noteId: string; purged: boolean }

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
