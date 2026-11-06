import { useState } from 'react'
import type { BookRecord } from '../../../core'
import type { Core } from '../core-client'
import { RevisionHistory, useHistoryMenu } from '../RevisionHistory'

/** The open note's revision history sheet, opened from the note's menu or the menu bar. */
export function useNoteHistory({
  core,
  editing,
  selected,
  inTrash,
  multiIds,
  title,
  books,
  select,
  applyToOpenNote,
}: {
  core: Core | undefined
  editing: boolean
  selected: string | undefined
  inTrash: boolean
  multiIds: readonly string[] | undefined
  title: string
  books: BookRecord[]
  select: (id: string) => Promise<boolean>
  applyToOpenNote: (noteId: string, update: Uint8Array) => void
}) {
  const [historyFor, setHistoryFor] = useState<string>()
  const showHistory = async (id: string | undefined) => {
    if (!id || inTrash) return
    if (id !== selected) await select(id)
    setHistoryFor(id)
  }
  useHistoryMenu(() => void (multiIds === undefined && showHistory(selected)))
  // The sheet belongs to the open note: another note or the Trash closes it
  // for good (also when opening the note failed).
  if (historyFor !== undefined && (historyFor !== selected || inTrash)) {
    setHistoryFor(undefined)
  }
  const sheet =
    core && historyFor && historyFor === selected && !inTrash ? (
      <RevisionHistory
        core={core}
        noteId={historyFor}
        title={title}
        books={books}
        onRestore={(update) => {
          applyToOpenNote(historyFor, update)
          setHistoryFor(undefined)
        }}
        onClose={() => setHistoryFor(undefined)}
        readOnly={!editing}
      />
    ) : null
  return { showHistory, sheet }
}
