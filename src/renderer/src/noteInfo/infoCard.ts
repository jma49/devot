// The open note's Note Info card (NoteInfoCard.tsx): its dates, its rule for them, and its folds.
export interface NoteInfoData {
  noteId: string
  createdAt: number
  updatedAt: number
}

/**
 * The dates to write when field `key` is set to `at`; null when the note
 * would be updated before it was created.
 */
export function datesEdit(
  info: Pick<NoteInfoData, 'createdAt' | 'updatedAt'>,
  key: 'created' | 'updated',
  at: number,
): { createdAt: number } | { updatedAt: number } | null {
  if (key === 'created') return at <= info.updatedAt ? { createdAt: at } : null
  return at >= info.createdAt ? { updatedAt: at } : null
}

export type InfoSection = 'properties' | 'backlinks'

const FOLD_KEY = 'devot.noteInfo.folded.'

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

function viewStorage(): KeyValue | undefined {
  try {
    return (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    return undefined
  }
}

/**
 * Whether a section of the card is open: a view preference of the window,
 * the same for every note, kept in the web view's storage (open at first).
 */
export function sectionOpen(
  section: InfoSection,
  storage: KeyValue | undefined = viewStorage(),
): boolean {
  try {
    return storage?.getItem(FOLD_KEY + section) !== '1'
  } catch {
    return true
  }
}

export function setSectionOpen(
  section: InfoSection,
  open: boolean,
  storage: KeyValue | undefined = viewStorage(),
) {
  try {
    storage?.setItem(FOLD_KEY + section, open ? '0' : '1')
  } catch {
    // A view preference that cannot be kept is only forgotten.
  }
}
