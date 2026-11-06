import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { TakenIn } from '../../../core'
import { EMPTY_TRAIL, type Trail } from '../../../core/navigation'
import type { Core } from '../core-client'
import type { EditorHandle } from '../editor/handle'
import { BODY_PLACEHOLDER_MS, useLateAttribute } from '../late'
import { useStable } from '../stable'

/** A note on its way to the window: the trail of notes opened, the body opened ahead, and the title shown meanwhile. */
export function useNoteOpening({
  selected,
  editorRef,
  panesRef,
}: {
  selected: string | undefined
  editorRef: RefObject<EditorHandle | null>
  panesRef: RefObject<HTMLDivElement | null>
}) {
  const [title, setTitle] = useState('')
  // Notes opened, for Back and Forward. The ref moves at once so quick presses each step on; the state renders it.
  const trailRef = useRef<Trail>(EMPTY_TRAIL)
  const [trail, setTrail] = useState(EMPTY_TRAIL)
  const moveTrail = (next: Trail) => {
    trailRef.current = next
    setTrail(next)
  }
  // Note a navigation is opening until the window shows it: quick Back/Forward/Next/Previous presses step on from it. Each open bumps `opens`; only the latest shows.
  const openingRef = useRef<string | undefined>(undefined)
  const opens = useRef(0)
  // The title field shows the note being left until the switch lands; typing then would rename that
  // note or merge with the title that arrives, so it is read-only meanwhile.
  // The list draws the note being opened as selected at once.
  const [openingId, setOpeningId] = useState<string>()
  const switching = openingId !== undefined && openingId !== selected
  // A title another window gave the note being opened, before its own title arrived.
  const openingTitle = useRef<{ noteId: string; title: string } | undefined>(undefined)
  const startOpening = (id: string) => {
    openingRef.current = id
    openingTitle.current = undefined
    setOpeningId(id)
    return ++opens.current
  }
  const stopOpening = () => {
    openingRef.current = undefined
    setOpeningId(undefined)
  }
  // A body opened for the editor to show next, held until the editor takes it.
  const preopened = useRef<{ core: Core; noteId: string; state: Uint8Array } | null>(null)
  const handOver = (next: { core: Core; noteId: string; state: Uint8Array }) => {
    const before = preopened.current
    if (before) void before.core.unhold(before.noteId)
    preopened.current = next
  }
  const takePreopened = useStable((from: Core, noteId: string) => {
    const given = preopened.current
    if (given?.core !== from || given.noteId !== noteId) return undefined
    preopened.current = null
    return given.state
  })
  // The editor takes a body in the commit that selects its note, in a layout effect that runs before
  // this one: a body still here was not taken (no editor shown, a multiple selection) and would go stale.
  useLayoutEffect(() => {
    const left = preopened.current
    if (!left) return
    preopened.current = null
    void left.core.unhold(left.noteId)
  })
  const [editorLoading, setEditorLoading] = useState(false)
  useLateAttribute(panesRef, 'data-loading', switching || editorLoading, BODY_PLACEHOLDER_MS)
  useEffect(() => {
    if (openingRef.current === selected) stopOpening()
  })
  const shownNote = useRef<string | undefined>(undefined)
  // oxlint-disable-next-line react/refs -- Callbacks made in this render read the note it shows.
  shownNote.current = selected
  const setShownNote = (id: string) => {
    shownNote.current = id
  }

  // Another window's change, or one the core merged in on saving: the editor and title field take it.
  const takeIn = useCallback(
    (change: TakenIn) => {
      if (change.kind === 'title') {
        if (shownNote.current === change.noteId) setTitle(change.title)
        else if (openingRef.current === change.noteId) openingTitle.current = change
        return
      }
      const editor = editorRef.current
      if (editor?.noteId === change.noteId) editor.takeState(change.update)
    },
    [editorRef],
  )

  return {
    title,
    setTitle,
    trailRef,
    trail,
    moveTrail,
    openingRef,
    opens,
    openingId,
    switching,
    openingTitle,
    startOpening,
    stopOpening,
    handOver,
    takePreopened,
    setEditorLoading,
    setShownNote,
    takeIn,
  }
}

export type NoteOpening = ReturnType<typeof useNoteOpening>
