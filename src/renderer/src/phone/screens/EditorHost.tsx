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
import { closeGate } from '../requireEditing'
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

// The keyboard is up when Swift asks, so the caret waits for the note's load however slow it is (over
// a second on a busy simulator); only an open that failed, which reports nothing, or a note that opens
// in Preview, takes no caret.
const FOCUS_WAIT_MS = 5000

interface Focusing {
  readonly noteId: string
  readonly typed: string
  readonly settle: (focused: boolean) => void
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
  const [shownMode, setShownMode] = useState<{ noteId: string; mode: 'edit' | 'preview' } | null>(
    null,
  )
  const commands = useRef<NoteCommands | null>(null)
  const typedIn = useRef<string | null>(null)
  const focusing = useRef<Focusing | null>(null)
  const [asking, setAsking] = useState<Focusing | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })

  const chrome = useMemo<NativeNoteChrome>(
    () => ({
      openNote: (id) => latest.current.openNote(id),
      loaded: setLoadedId,
      mode: (noteId, mode) => {
        setShownMode({ noteId, mode })
        latest.current.notify({ notice: 'editor.mode', noteId, mode })
      },
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
      show: (noteId, focusBody) => {
        typedIn.current = focusBody ? noteId : null
        focusing.current?.settle(false)
        // A screen took the page, so the one a held write was asked on has gone.
        closeGate()
        setShown((before) => ({ noteId, turn: (before?.turn ?? 0) + 1 }))
        setVisible(true)
      },
      hide: () => {
        typedIn.current = null
        focusing.current?.settle(false)
        commands.current?.leave()
        // A write held for the screen being left must not run on an unlock after it has gone.
        closeGate()
        setVisible(false)
        return new Promise<void>((resolve) => afterPaint(resolve))
      },
      setMode: (mode) => commands.current?.setMode(mode),
      info: () => commands.current?.info(),
      focus: (typed) =>
        new Promise<boolean>((resolve) => {
          const noteId = typedIn.current
          if (noteId === null) return resolve(false)
          focusing.current?.settle(false)
          const timer = setTimeout(() => asked.settle(false), FOCUS_WAIT_MS)
          const asked: Focusing = {
            noteId,
            typed,
            settle: (focused) => {
              if (focusing.current !== asked) return
              focusing.current = null
              clearTimeout(timer)
              resolve(focused)
            },
          }
          focusing.current = asked
          setAsking(asked)
        }),
    }),
    [],
  )

  useEffect(() => {
    if (!asking || focusing.current !== asking || !visible) return
    const { noteId } = asking
    if (shown?.noteId !== noteId || loadedId !== noteId) return
    if (shownMode?.noteId !== noteId || shownMode.mode !== 'edit') return
    asking.settle(commands.current?.focusBody(asking.typed) ?? false)
  }, [asking, visible, shown, loadedId, shownMode])

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
