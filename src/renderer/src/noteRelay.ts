// Carries the core's relay messages between the windows that edit notes (src/core/noteRelay.ts). The
// worker sends them on its own channel (noteRelayWire.ts); the page hands them to Rust
// (note_relay_send), which passes them to the main window and the note's own window, and each page
// hears only what reaches it (devot://note-relay on its own window). The UI tests' build carries
// them between the pages of one browser through a BroadcastChannel, routed as Rust routes them.
import { errorCode } from '../../core/errors'
import { invoke } from './ipc'
import type { WireRelay } from './noteRelayWire'

export type { WireRelay } from './noteRelayWire'

export const MAIN_WINDOW = 'main'
const EVENT = 'devot://note-relay'
const TEST_CHANNEL = 'devot.test.noteRelay'

export const noteWindowLabel = (noteId: string) => `note-${noteId}`

/** Whether the window `label` hears what is said about `noteId`, as Rust routes it (note_relay.rs). */
export const hears = (label: string, noteId: string) =>
  label === MAIN_WINDOW || label === noteWindowLabel(noteId)

/**
 * Which of the core's messages to send. A note window always sends: another window shows its note. A
 * main window sends what it asks for (`want`), and the changes to a note once another window has
 * spoken of it, so a window alone costs nothing for each keystroke.
 */
export function relayGate(always: boolean) {
  const spoken = new Set<string>()
  return {
    heard: (noteId: string) => void spoken.add(noteId),
    allows: (message: WireRelay) => always || message.kind === 'want' || spoken.has(message.noteId),
  }
}

export interface RelayLink {
  send(message: WireRelay): void
  listen(handler: (message: WireRelay) => void): () => void
}

export function relayLink(self: string): RelayLink {
  if (DEVOT_UI_TEST) {
    const channel = new BroadcastChannel(TEST_CHANNEL)
    return {
      send: (message) => channel.postMessage({ from: self, message }),
      listen(handler) {
        const take = (event: MessageEvent<{ from: string; message: WireRelay }>) => {
          const { from, message } = event.data
          if (from !== self && hears(self, message.noteId)) handler(message)
        }
        channel.addEventListener('message', take)
        return () => channel.removeEventListener('message', take)
      },
    }
  }
  return {
    send(message) {
      invoke('note_relay_send', { message }).catch((e: unknown) =>
        console.warn('W_NOTE_RELAY_SEND_FAILED', message.noteId, errorCode(e)),
      )
    },
    listen(handler) {
      let stopped = false
      let unlisten: (() => void) | undefined
      void import('@tauri-apps/api/webviewWindow')
        .then(async ({ getCurrentWebviewWindow }) => {
          const stop = await getCurrentWebviewWindow().listen<WireRelay>(EVENT, (e) =>
            handler(e.payload),
          )
          if (stopped) stop()
          else unlisten = stop
        })
        .catch(() => console.warn('W_NOTE_RELAY_LISTEN_FAILED'))
      return () => {
        stopped = true
        unlisten?.()
      }
    },
  }
}
