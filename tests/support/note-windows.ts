// Windows of one Devot on one storage, as in the app: each window runs a core of its own, which holds
// a Yjs copy of every note it uses, and an editor replica of each note it shows (as NoteEditor does).
// What a core relays reaches every other window's inbox (as Rust's note_relay_send does) and waits
// there until a test delivers it, in any order.
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  type NoteService,
  type NoteServiceOptions,
  type TakenIn,
  type NoteRelayMessage,
  type StorageAdapter,
} from '../../src/core'

/** Changes the core sends the editor: applied without being sent back, as y-codemirror's remote origin. */
const FROM_CORE = Symbol('from core')

export interface NoteWindow {
  name: string
  notes: NoteService
  inbox: NoteRelayMessage[]
  editors: Map<string, Y.Doc>
  /** The titles the core took in from elsewhere. */
  titles: Map<string, string>
  /** Every update this window's editors made, in order. */
  typed: Uint8Array[]
}

export function windowsOn(
  storage: StorageAdapter,
  names: readonly string[],
  options: Partial<NoteServiceOptions> = {},
) {
  const windows: NoteWindow[] = []
  const busy = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>) => {
    busy.add(work)
    void work.finally(() => busy.delete(work)).catch(() => {})
    return work
  }

  for (const name of names) {
    const w: NoteWindow = {
      name,
      notes: undefined as unknown as NoteService,
      inbox: [],
      editors: new Map(),
      titles: new Map(),
      typed: [],
    }
    const onTakenIn = (change: TakenIn) => {
      if (change.kind === 'title') w.titles.set(change.noteId, change.title)
      else {
        const editor = w.editors.get(change.noteId)
        if (editor) Y.applyUpdate(editor, change.update, FROM_CORE)
      }
    }
    w.notes = createNoteService({
      storage,
      clock: createClock(name),
      newId: createIdGenerator(),
      saveDelayMs: 10_000,
      ...options,
      relay: (message) => {
        for (const other of windows) if (other !== w) other.inbox.push(message)
      },
      onTakenIn,
    })
    windows.push(w)
  }

  /** Waits for every editor update handed to a core so far. */
  const settle = async () => {
    while (busy.size > 0) await Promise.allSettled([...busy])
  }

  /** Shows the note in `w`'s editor: its core holds the note and the replica starts from its state. */
  const show = async (w: NoteWindow, id: string) => {
    w.notes.hold(id)
    const opened = await w.notes.open(id)
    const editor = new Y.Doc()
    Y.applyUpdate(editor, opened.state, FROM_CORE)
    editor.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === FROM_CORE) return
      w.typed.push(update)
      void track(w.notes.applyUpdate(id, update))
    })
    w.editors.set(id, editor)
    return editor
  }

  const editorText = (w: NoteWindow, id: string) =>
    w.editors.get(id)?.getText(BODY).toString() ?? ''

  /** Delivers the message at `index` of `w`'s inbox (the first by default). */
  const deliver = async (w: NoteWindow, index = 0) => {
    const [message] = w.inbox.splice(index, 1)
    if (message) await w.notes.receive(message)
    await settle()
  }

  /** Delivers until every inbox is empty: a delivery can answer with messages of its own. */
  const deliverAll = async () => {
    await settle()
    while (windows.some((w) => w.inbox.length > 0)) {
      for (const w of windows) while (w.inbox.length > 0) await deliver(w)
    }
  }

  return { windows, show, editorText, deliver, deliverAll, settle }
}
