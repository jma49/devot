import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import type { NoteSummary } from '../../../../core/storage'
import { PhoneNote, type NativeNoteChrome, type NoteCommands } from '../PhoneNote'
import type { PhoneStore } from '../usePhoneData'
import type { NativeEditor } from './editor'
import type { ScreensNotice } from './message'
import type { PreparedNotes } from './prepared'

/** Runs `then` once the frame after the next has started, when the last change has been painted. */
function afterPaint(then: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(then)
  })
  return () => cancelAnimationFrame(frame)
}

/**
 * The note shown in the native editor screen: one editor for the page's lifetime, which takes each
 * note Swift shows. Hidden, it keeps its note, so going back to it costs nothing.
 */
export function EditorHost(props: {
  store: PhoneStore
  notify: (notice: ScreensNotice) => void
  editor: RefObject<NativeEditor | null>
  prepared: PreparedNotes
  openNote: (id: string) => void
  onTrash: (note: NoteSummary) => void
}) {
  const [shown, setShown] = useState<{ noteId: string; turn: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const commands = useRef<NoteCommands | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })

  const chrome = useMemo<NativeNoteChrome>(
    () => ({
      openNote: (id) => latest.current.openNote(id),
      loaded: setLoadedId,
      mode: (noteId, mode) => latest.current.notify({ notice: 'editor.mode', noteId, mode }),
      title: (id, title) => latest.current.notify({ notice: 'editor.title', id, title }),
      titleVisible: (titleVisible) =>
        latest.current.notify({ notice: 'editor.scroll', titleVisible }),
      commands,
      turn: shown?.turn ?? 0,
    }),
    [shown?.turn],
  )

  useImperativeHandle(
    props.editor,
    (): NativeEditor => ({
      show: (noteId) => {
        setShown((before) => ({ noteId, turn: (before?.turn ?? 0) + 1 }))
        setVisible(true)
      },
      hide: () => {
        commands.current?.leave()
        setVisible(false)
        return new Promise<void>((resolve) => afterPaint(resolve))
      },
      setMode: (mode) => commands.current?.setMode(mode),
      info: () => commands.current?.info(),
    }),
    [],
  )

  const readyTurn = useRef(0)
  useEffect(() => {
    if (!visible || !shown || loadedId !== shown.noteId || readyTurn.current === shown.turn) return
    const { noteId, turn } = shown
    return afterPaint(() => {
      readyTurn.current = turn
      latest.current.notify({ notice: 'editor.ready', noteId })
    })
  }, [visible, shown, loadedId])

  return (
    <div className="phone-editor-host" data-shown={visible ? '' : undefined} inert={!visible}>
      {shown && (
        <PhoneNote
          store={props.store}
          noteId={shown.noteId}
          onBack={() => latest.current.notify({ notice: 'nav.back' })}
          onTrash={(note) => latest.current.onTrash(note)}
          native={chrome}
          takePreopened={props.prepared.take}
        />
      )}
    </div>
  )
}
