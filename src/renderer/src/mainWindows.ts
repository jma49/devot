// Several main windows (src-tauri/src/main_windows.rs): File > New Window opens another one. Each runs a
// core of its own on the one library; a note's text and title reach the other windows through the note
// relay (noteRelay.ts), and everything else a window writes (a status, a notebook, a tag, a note made
// or trashed) reaches their lists through `lists-changed`: a window that wrote tells Rust once its
// writes settle, Rust tells the other main windows, and each loads its lists and the notes it holds
// again as it does for a change another process made (externalChanges.ts).
import { errorCode } from '../../core/errors'
import { invoke } from './ipc'
import type { WireStorage } from './storage/wire'

const EVENT = 'devot://lists-changed'
const TEST_CHANNEL = 'devot.test.listsChanged'

/** Runs `run` once, `ms` after the first call that finds nothing waiting. */
export function coalesced(run: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      run()
    }, ms)
  }
}

/** Calls `onWrote` after each write that changes what the lists show; `storage` is otherwise as it was. */
export function reportingWrites(storage: WireStorage, onWrote: () => void): WireStorage {
  const after =
    <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      await write(...args)
      onWrote()
    }
  // A write that changed no row, another window having got there first, has
  // nothing to tell the others about.
  const afterChange =
    <A extends unknown[]>(write: (...args: A) => Promise<number>) =>
    async (...args: A) => {
      const changed = await write(...args)
      if (changed > 0) onWrote()
      return changed
    }
  return {
    ...storage,
    purgeNote: after((id, at, hlc) => storage.purgeNote(id, at, hlc)),
    putNote: after((note, links) => storage.putNote(note, links)),
    putFile: after((meta, data) => storage.putFile(meta, data)),
    copyFiles: after((noteId, copies) => storage.copyFiles(noteId, copies)),
    putBook: after((book) => storage.putBook(book)),
    putTag: after((tag) => storage.putTag(tag)),
    putNoteTag: after((link) => storage.putNoteTag(link)),
    markAgentWritesSeen: afterChange((noteId, writeIds) =>
      storage.markAgentWritesSeen(noteId, writeIds),
    ),
  }
}

export interface ListsLink {
  /** Tells the other main windows this one wrote to the library. */
  send(): void
  /** Resolves, with the way to stop, once the page hears the others; it never rejects. */
  listen(handler: () => void): Promise<() => void>
}

/**
 * The link of the main window `self`. The UI tests' build carries the news between the pages of one
 * browser through a BroadcastChannel, to every page but the sender, as Rust does.
 */
export function listsLink(self: string): ListsLink {
  if (DEVOT_UI_TEST) {
    const channel = new BroadcastChannel(TEST_CHANNEL)
    return {
      send: () => channel.postMessage({ from: self }),
      listen(handler) {
        const take = (event: MessageEvent<{ from: string }>) => {
          if (event.data.from !== self) handler()
        }
        channel.addEventListener('message', take)
        return Promise.resolve(() => channel.removeEventListener('message', take))
      },
    }
  }
  return {
    send() {
      invoke('main_windows_changed').catch((e: unknown) =>
        console.warn('W_MAIN_WINDOWS_CHANGED_FAILED', errorCode(e)),
      )
    },
    listen: (handler) =>
      import('@tauri-apps/api/webviewWindow')
        .then(({ getCurrentWebviewWindow }) => getCurrentWebviewWindow().listen(EVENT, handler))
        .catch(() => {
          console.warn('W_MAIN_WINDOWS_LISTEN_FAILED')
          return () => {}
        }),
  }
}

/** File > New Window, or the palette's New Window. */
export const openMainWindow = () =>
  invoke('main_window_new').catch((e: unknown) => {
    console.warn('W_MAIN_WINDOW_OPEN_FAILED', errorCode(e))
  })
