import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { buildBookTree } from '../../../core/books'
import { errorCode } from '../../../core/errors'
import type { NoteSummary } from '../../../core/storage'
import { editorSettings } from '../editorSettings'
import { motionMs } from '../motionTiming'
import { motionReduced } from '../motionPreference'
import {
  initialNavigation,
  layerPlacement,
  navigate,
  PHONE_TABS,
  releasePops,
  releaseSpeed,
  type PhoneNavigationAction,
  type PhoneRoute,
  type PhoneTab,
} from './navigation'
import { discardNewNote, makeNewNote, newNoteBook, untouched, type MadeNote } from './newNote'
import { startPhoneRoot } from './spring'
import { watchDragEnd, type DragEnd } from './dragEnd'
import { PhoneActivity } from './PhoneActivity'
import { usePhoneData } from './usePhoneData'
import { editingAllowed, startLicence, useLicence } from '../licence'
import { dailySettings } from '../app/useNoteMaking'
import { choicesFromTree } from '../notebookChoices'
import { activityHandlers } from './screens/activity'
import { startScreensBridge, type ScreensBridge } from './screens/bridge'
import { noteHandlers } from './screens/notes'
import { SCREENS_HANDLERS } from './screens/ops'
import { glassHandlers } from './screens/glass'
import { settingsHandlers, type NativeSettings } from './screens/settings'
import { tabHandlers, tabsState, type NativeTabs } from './screens/tabs'
import { editorHandlers, type NativeEditor } from './screens/editor'
import { newNoteHandlers, type NativeNewNote } from './screens/newNote'
import { noteChangesRev, watchLibraryChanges, watchNoteChanges } from './screens/noteChanges'
import { listHandlers } from './screens/lists'
import { searchHandlers } from './screens/search'
import { EditorHost } from './screens/EditorHost'
import { createPreparedNotes } from './screens/prepared'
import { modalOpen, watchModals } from './modal'
import { useSpikes } from './screens/useSpikes'
import { currentWindowLabel } from '../focus'
import { useSyncEngine } from '../sync'
import { licenceRow, welcomeDue } from './settingsRows'
import { openPurchase } from '../purchaseSheet'
import { PhoneGate } from './PhoneProSheet'
import { dropIntent } from './requireEditing'
import { applyGlassPrefs } from './glassPrefs'
import { routeHaptics } from './haptics'
import { PhoneNote } from './PhoneNote'
import { useLicenceClock } from './licenceClock'
import './phone.css'

function Layer(props: {
  index: number
  x: string
  dim: number
  phase: 'rest' | 'leaving'
  covered: boolean
  dragging: boolean
  children: ReactNode
}) {
  const [entered, setEntered] = useState(props.index === 0)
  useEffect(() => {
    // One frame off screen first, so that arriving is a transition.
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const away = !entered || props.phase === 'leaving'
  return (
    <div
      className="phone-layer"
      data-away={away || undefined}
      data-dragging={props.dragging || undefined}
      inert={props.covered || props.phase === 'leaving'}
      style={{
        zIndex: props.index === 0 ? 1 : 1 + props.index * 2,
        transform: `translateX(${away ? '100vw' : props.x})`,
      }}
    >
      {props.children}
      <div className="phone-layer-dim" style={{ opacity: props.dim }} />
    </div>
  )
}

function leavingDuration(): number {
  return motionReduced()
    ? motionMs('motion.duration.phone-crossfade')
    : motionMs('motion.duration.phone-push')
}

function Stack(props: {
  routes: readonly PhoneRoute[]
  active: boolean
  drag: number
  width: number
  dragging: boolean
  render: (route: PhoneRoute) => ReactNode
}) {
  const [leaving, setLeaving] = useState<{ route: PhoneRoute; index: number } | null>(null)
  const previous = useRef(props.routes)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = props.routes
    if (props.routes.length >= before.length) return
    const index = before.length - 1
    setLeaving({ route: before[index]!, index })
    const timer = setTimeout(() => setLeaving(null), leavingDuration())
    return () => clearTimeout(timer)
  }, [props.routes])
  const top = props.routes.length - 1
  return (
    <div className="phone-stack" hidden={!props.active}>
      {props.routes.map((route, index) => {
        const { x, dim } = layerPlacement(index, top, props.drag, props.width)
        return (
          <Layer
            key={route.id}
            index={index}
            x={x}
            dim={dim}
            phase="rest"
            covered={index !== top}
            dragging={props.dragging}
          >
            {props.render(route)}
          </Layer>
        )
      })}
      {leaving && !props.routes.some((route) => route.id === leaving.route.id) && (
        <Layer
          key={leaving.route.id}
          index={leaving.index}
          x="0px"
          dim={0}
          phase="leaving"
          covered
          dragging={false}
        >
          {props.render(leaving.route)}
        </Layer>
      )}
    </div>
  )
}

function BackSwipeZone(props: {
  onMove: (drag: number) => void
  onRelease: (pops: boolean) => void
}) {
  const start = useRef<{
    pointer: number
    x: number
    lastX: number
    lastTime: number
    speed: number
    stop: () => void
  } | null>(null)
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  // Leaving mid-swipe (the screen popped) must not leave the screens offset.
  useEffect(() => () => start.current?.stop(), [])
  const move = (event: PointerEvent) => {
    const swipe = start.current
    if (!swipe || swipe.pointer !== event.pointerId) return
    const elapsed = event.timeStamp - swipe.lastTime
    if (elapsed > 0) swipe.speed = (event.clientX - swipe.lastX) / elapsed
    swipe.lastX = event.clientX
    swipe.lastTime = event.timeStamp
    props.onMove(Math.max(0, event.clientX - swipe.x))
  }
  const end = (how: DragEnd, event: globalThis.PointerEvent | null) => {
    const swipe = start.current
    if (!swipe) return
    start.current = null
    latest.current.onRelease(
      how === 'release' &&
        event !== null &&
        releasePops(
          event.clientX - swipe.x,
          releaseSpeed(swipe.speed, event.timeStamp - swipe.lastTime),
        ),
    )
  }
  return (
    <div
      aria-hidden="true"
      className="phone-back-zone"
      data-testid="phone-back-zone"
      onPointerDown={(event) => {
        if (start.current) return
        event.currentTarget.setPointerCapture(event.pointerId)
        start.current = {
          pointer: event.pointerId,
          x: event.clientX,
          lastX: event.clientX,
          lastTime: event.timeStamp,
          speed: 0,
          stop: watchDragEnd(event.currentTarget, event.pointerId, end),
        }
      }}
      onPointerMove={move}
    />
  )
}

// Rust takes at most this many IDs in one `notes.changed`.
const MAX_CHANGED_IDS = 10_000

const without = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids)
  next.delete(id)
  return next
}

/** Where focus and a pending intent go when the page leaves a tab. */
const leaveTab = () => {
  dropIntent()
  // A hidden tab keeps its focus, so a field that saves when it is left would never save.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

/** What the UI tests drive the fallback with, since it has no tab bar or lists of its own. */
interface PhoneTestDriver {
  showTab(tab: PhoneTab): void
  openNote(noteId: string): void
  notes(): readonly NoteSummary[]
}

export function PhoneApp() {
  const [state, dispatch] = useReducer(navigate, undefined, initialNavigation)
  const bridge = useRef<ScreensBridge | null>(null)
  const phoneData = usePhoneData(() => bridge.current?.libraryListed())
  const [discarding, setDiscarding] = useState<ReadonlySet<string>>(() => new Set())
  // A discarded note leaves every screen the moment it is left, before its purge returns.
  const store =
    discarding.size === 0
      ? phoneData
      : {
          ...phoneData,
          notes: phoneData.notes.filter((n) => !discarding.has(n.id)),
          templates: phoneData.templates.filter((n) => !discarding.has(n.id)),
        }
  const [label] = useState(currentWindowLabel)
  useSyncEngine(store.core, label)
  const [drag, setDrag] = useState(0)
  const [dragging, setDragging] = useState(false)
  const licence = useLicence()
  const welcomed = useRef(false)
  const now = useLicenceClock(licence)
  const root = useRef<HTMLDivElement>(null)
  const made = useRef(new Map<string, MadeNote>())
  const latest = useRef(state)
  const nativeTabs = useRef<NativeTabs | null>(null)
  const nativeSettings = useRef<NativeSettings | null>(null)
  const nativeEditor = useRef<NativeEditor | null>(null)
  const nativeNewNote = useRef<NativeNewNote | null>(null)
  const [prepared] = useState(createPreparedNotes)
  // Null until the bridge says whether the native screens are there; without them the page is the fallback.
  const [native, setNative] = useState<boolean | null>(null)
  const covered = useSyncExternalStore(watchModals, modalOpen)
  const latestStore = useRef(store)
  useLayoutEffect(() => {
    latest.current = state
    latestStore.current = store
  })
  useEffect(() => (root.current ? startPhoneRoot(root.current) : undefined), [])
  useEffect(() => startLicence(), [])
  useEffect(() => {
    const started = startScreensBridge({
      ...SCREENS_HANDLERS,
      ...tabHandlers({
        show: (tab) => nativeTabs.current?.show(tab),
        popToRoot: (tab) => nativeTabs.current?.popToRoot(tab),
      }),
      ...settingsHandlers({
        notebooks: () => nativeSettings.current?.notebooks() ?? [],
      }),
      ...editorHandlers(() => nativeEditor.current, {
        prepare: (noteId) => {
          const core = latestStore.current.core
          if (core) prepared.prepare(core, noteId)
        },
      }),
      ...glassHandlers(),
      ...newNoteHandlers(() => nativeNewNote.current),
      ...listHandlers(() => latestStore.current.started()),
      ...searchHandlers(() => latestStore.current.started()),
      ...noteHandlers(
        () => latestStore.current.core,
        () => {
          const { notes, templates, tags, refresh } = latestStore.current
          return {
            note: (id) => notes.find((n) => n.id === id) ?? templates.find((n) => n.id === id),
            tags,
            refresh,
          }
        },
      ),
      ...activityHandlers(async () => {
        const core = await latestStore.current.started()
        return {
          writing: (at) => core.writing(at),
          titles: () => new Map(latestStore.current.notes.map((note) => [note.id, note.title])),
        }
      }),
    })
    bridge.current = started
    let live = true
    void started.installed.then((installed) => {
      if (live) setNative(installed)
    })
    return () => {
      live = false
      started.stop()
      prepared.clear()
    }
  }, [prepared])
  useSpikes(store.core)
  useEffect(() => {
    if (welcomed.current || !welcomeDue(licence, Date.now())) return
    welcomed.current = true
    openPurchase()
  }, [licence])

  const width = window.innerWidth
  const stack = state.stacks[state.tab]
  const depth = stack.length - 1
  const attention = licenceRow(licence, now).needsAttention
  const { barHidden } = tabsState(state, covered, attention)

  // Read afresh: a chip changed in the editor may not have reached the lists yet.
  const leaveNewNote = (id: string, before: MadeNote | null = null) => {
    const note = made.current.get(id) ?? before
    made.current.delete(id)
    const core = phoneData.core
    if (!note || !core) return
    void core
      .listWithTemplates()
      .then(async ({ notes, templates }) => {
        if (
          !untouched(
            note,
            [...notes, ...templates].find((n) => n.id === id),
          )
        )
          return
        setDiscarding((ids) => new Set(ids).add(id))
        if (await discardNewNote(core, id)) await phoneData.refresh()
        setDiscarding((ids) => without(ids, id))
      })
      .catch((error: unknown) => console.warn('W_PHONE_DISCARD_FAILED', errorCode(error)))
  }

  const go = useCallback((action: PhoneNavigationAction) => {
    latest.current = navigate(latest.current, action)
    dispatch(action)
  }, [])

  useLayoutEffect(() => {
    nativeTabs.current = {
      show: (tab) => {
        if (tab === latest.current.tab) return
        leaveTab()
        go({ type: 'selectTab', tab })
      },
      popToRoot: (tab) => {
        if (tab === latest.current.tab) go({ type: 'selectTab', tab })
      },
    }
    nativeSettings.current = {
      notebooks: () => choicesFromTree(buildBookTree(store.books)),
    }
    nativeNewNote.current = {
      create: async (named) => {
        const core = await latestStore.current.started()
        const bookId = newNoteBook(
          named,
          editorSettings().defaultNotebook,
          latestStore.current.books,
        )
        const id = await makeNewNote(core, bookId)
        // The write that made the note is reported in a microtask: the reply counts it.
        await Promise.resolve()
        const rev = noteChangesRev()
        made.current.set(id, { bookId })
        void phoneData.refresh()
        return { id, rev }
      },
      discard: (noteId, before) => leaveNewNote(noteId, before),
      today: async () => {
        const core = await latestStore.current.started()
        const { id } = await core.openTodaysNote(dailySettings(), Date.now(), editingAllowed())
        void phoneData.refresh()
        return { id }
      },
    }
  })
  useEffect(() => {
    if (!native) return
    const notes = watchNoteChanges((rev, ids, all) =>
      bridge.current?.notify({
        notice: 'notes.changed',
        rev,
        // Past the limit Swift cannot read the rows named, so it reads every list again.
        ids: ids.length > MAX_CHANGED_IDS ? [] : ids,
        ...(all || ids.length > MAX_CHANGED_IDS ? { all: true as const } : {}),
      }),
    )
    const library = watchLibraryChanges((notice) => bridge.current?.notify({ notice }))
    return () => {
      notes()
      library()
    }
  }, [native])
  useEffect(() => {
    if (!native) return
    routeHaptics((kind) => bridge.current?.notify({ notice: 'editor.haptic', kind }))
    return () => routeHaptics(null)
  }, [native])
  useEffect(() => {
    if (native)
      bridge.current?.notify({ notice: 'tabs.state', tab: state.tab, barHidden, attention })
  }, [native, state.tab, barHidden, attention])
  // The fallback has no lists: it opens on Activity, whose notes open.
  useEffect(() => {
    if (native === false) go({ type: 'selectTab', tab: 'activity' })
  }, [native, go])
  useEffect(() => {
    if (!DEVOT_UI_TEST || native !== false) return
    const driven = globalThis as { devotPhone?: PhoneTestDriver }
    driven.devotPhone = {
      showTab: (tab) => {
        leaveTab()
        go({ type: 'selectTab', tab })
      },
      openNote: (noteId) => go({ type: 'push', screen: 'note', noteId }),
      notes: () => latestStore.current.notes,
    }
    return () => {
      delete driven.devotPhone
    }
  }, [native, go])

  const pop = () => go({ type: 'pop' })
  // Under the native screens Swift pushes the note's own screen; the web stack never draws it.
  const openNote = (noteId: string) => {
    if (!native) {
      go({ type: 'push', screen: 'note', noteId })
      return
    }
    const note = [...store.notes, ...store.templates].find((n) => n.id === noteId)
    bridge.current?.notify({ notice: 'nav.openNote', noteId, title: note?.title ?? '' })
  }

  const render = (tab: PhoneTab, route: PhoneRoute) => {
    if (route.screen === 'note' && route.noteId)
      return <PhoneNote store={store} noteId={route.noteId} onBack={pop} />
    if (tab === 'activity' && native === false)
      return <PhoneActivity data={store} onOpenNote={openNote} />
    return null
  }

  useLayoutEffect(applyGlassPrefs, [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const stop = (event: Event) => event.preventDefault()
    el.addEventListener('gesturestart', stop)
    el.addEventListener('gesturechange', stop)
    return () => {
      el.removeEventListener('gesturestart', stop)
      el.removeEventListener('gesturechange', stop)
    }
  }, [])

  return (
    <div ref={root} className="phone-app">
      {PHONE_TABS.map((tab) => (
        <Stack
          key={tab}
          routes={state.stacks[tab]}
          active={tab === state.tab}
          drag={tab === state.tab ? drag : 0}
          width={width}
          dragging={dragging}
          render={(route) => render(tab, route)}
        />
      ))}
      {native && (
        <EditorHost
          store={store}
          notify={(notice) => bridge.current?.notify(notice)}
          editor={nativeEditor}
          prepared={prepared}
          openNote={openNote}
        />
      )}
      <PhoneGate
        licence={licence}
        onOpenLicence={(focusKey) => {
          bridge.current?.notify({ notice: 'settings.open', pane: 'licence', focusKey })
        }}
      />
      {depth > 0 && (
        <BackSwipeZone
          onMove={(next) => {
            setDragging(true)
            setDrag(next)
          }}
          onRelease={(pops) => {
            setDragging(false)
            setDrag(0)
            if (pops) pop()
          }}
        />
      )}
    </div>
  )
}
