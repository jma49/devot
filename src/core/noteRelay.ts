// What one window's core tells the cores of the other windows that show a note (a note window, the
// main window), so two windows editing one note never part: each holds a Yjs copy, and every change
// to it reaches the others at once. The app carries the messages through Rust (`note_relay_send`).
// Delivery may lag or reorder; Yjs merges updates in any order.

export type NoteRelayMessage =
  /** A change to a note's body, as the Yjs update it made. */
  | { kind: 'update'; noteId: string; data: Uint8Array }
  /** A core read the note in: what it holds, as a Yjs state vector, for the others to send what it lacks. */
  | { kind: 'want'; noteId: string; data: Uint8Array }
  | { kind: 'title'; noteId: string; title: string; hlc: string }
  /** A write of the note was stored, dated `updatedAt` (for the lists). */
  | { kind: 'saved'; noteId: string; updatedAt: number }

/** What a note in memory took in that its own window did not make, for the editor and title field that show it. */
export type TakenIn =
  | { kind: 'update'; noteId: string; update: Uint8Array }
  | { kind: 'title'; noteId: string; title: string }
