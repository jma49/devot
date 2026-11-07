import {
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
import { TEMPLATES_BOOK_ID } from '../../../core/templatesBook'
import { editorSettings } from '../editorSettings'
import {
  startEarlyKeys,
  takeEarlyKeys,
  type EarlyKey,
  type EarlyKeysTicket,
} from '../editor/earlyKeys'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
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
import {
  discardNewNote,
  listUnderNewNote,
  makeNewNote,
  newNoteBook,
  newNoteOffered,
  newNotesLeft,
  untouched,
  type MadeNote,
  type ShownList,
} from './newNote'
import { startPhoneRoot } from './spring'
import { watchDragEnd, type DragEnd } from './dragEnd'
import type { PhoneView } from './library'
import { PhoneActivity } from './PhoneActivity'
import { PhoneLibrary } from './PhoneLibrary'
import { usePhoneData, type PhoneData } from './usePhoneData'
import { haptic } from './haptics'
import { startLicence, useLicence } from '../licence'
import { choicesFromTree } from '../notebookChoices'
import { startScreensBridge, type ScreensBridge } from './screens/bridge'
import { SCREENS_HANDLERS } from './screens/ops'
import { settingsHandlers, type NativeSettings } from './screens/settings'
import { tabHandlers, tabsState, type NativeTabs } from './screens/tabs'
import { modalOpen, watchModals } from './modal'
import { useSpikes } from './screens/useSpikes'
import { currentWindowLabel } from '../focus'
import { useSyncEngine } from '../sync'
import { licenceRow, welcomeDue } from './settingsRows'
import { openPurchase } from '../purchaseSheet'
import { PhoneGate } from './PhoneProSheet'
import { dropIntent, refusedWrite, requireEditing, watchWrite } from './requireEditing'
import { applyGlassPrefs } from './glassPrefs'
import { PhoneNote } from './PhoneNote'
import { PhoneNoteList } from './PhoneNoteList'
import { PhoneSearch } from './PhoneSearch'
import { PhoneToast, useUndoToast } from './PhoneToast'
import { PhoneSettings, PhoneSettingsPane } from './PhoneSettings'
import { PhoneTabBar } from './PhoneTabBar'
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
  covered: boolean
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
    <div className="phone-stack" hidden={!props.active} inert={props.covered}>
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
  // Leaving mid-swipe (search opened, the screen popped) must not leave the screens offset.
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

function viewTitle(view: PhoneView | undefined, data: PhoneData): string {
  switch (view?.kind) {
    case 'pinned':
      return t('sidebar.pinned')
    case 'book':
      return data.books.find((b) => b.id === view.id)?.name ?? t('sidebar.notebooks')
    case 'tag':
      return data.tags.find((tag) => tag.id === view.id)?.name ?? t('sidebar.tags')
    case 'templates':
      return t('sidebar.templates')
    case 'trash':
      return t('sidebar.trash')
    default:
      return t('sidebar.allNotes')
  }
}

const ARRIVAL_MS = 1200

interface Made extends MadeNote {
  touched: boolean
  handedOver: boolean
}

const without = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids)
  next.delete(id)
  return next
}

/** The notes a screen lists: the Notes root (a smart tile's view and status) or a pushed list. */
const listOf = (tab: PhoneTab, route: PhoneRoute, notes: ShownList): ShownList | null =>
  route.screen === 'list'
    ? { view: route.view ?? { kind: 'all' }, status: 'all' }
    : tab === 'notes' && route.screen === 'root'
      ? notes
      : null

/** Where focus and a pending intent go when the page leaves a tab. */
const leaveTab = () => {
  dropIntent()
  // A hidden tab keeps its focus, so a field that saves when it is left would never save.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
}

const takeProxyText = (proxy: HTMLTextAreaElement): EarlyKey[] => {
  const text = proxy.value
  proxy.value = ''
  return [...text].map((key) => ({ key, shift: false }))
}

export function PhoneApp() {
  const [state, dispatch] = useReducer(navigate, undefined, initialNavigation)
  const phoneData = usePhoneData()
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
  const [arrivedId, setArrivedId] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>()
  const licence = useLicence()
  const welcomed = useRef(false)
  const undoable = useUndoToast(store)
  const now = useLicenceClock(licence)
  const root = useRef<HTMLDivElement>(null)
  const keyboardProxy = useRef<HTMLTextAreaElement>(null)
  const made = useRef(new Map<string, Made>())
  const earlyKeys = useRef<EarlyKeysTicket | null>(null)
  const making = useRef(false)
  const composing = useRef(false)
  const committedLater = useRef<(() => void) | null>(null)
  const latest = useRef(state)
  const nativeTabs = useRef<NativeTabs | null>(null)
  const nativeSettings = useRef<NativeSettings | null>(null)
  const bridge = useRef<ScreensBridge | null>(null)
  // Null until the bridge says whether the native tab bar is there; the page draws its own without it.
  const [native, setNative] = useState<boolean | null>(null)
  const covered = useSyncExternalStore(watchModals, modalOpen)
  useLayoutEffect(() => {
    latest.current = state
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
        showPane: (pane, anchor) => nativeSettings.current?.showPane(pane, anchor),
        notebooks: () => nativeSettings.current?.notebooks() ?? [],
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
    }
  }, [])
  useSpikes(store.core)
  useEffect(() => {
    if (welcomed.current || !welcomeDue(licence, Date.now())) return
    welcomed.current = true
    openPurchase()
  }, [licence])
  useEffect(() => {
    if (arrivedId === null) return
    const timer = setTimeout(() => setArrivedId(null), ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [arrivedId])

  const width = window.innerWidth
  const stack = state.stacks[state.tab]
  const depth = stack.length - 1
  const top = stack[depth]!
  const rootX = depth === 0 ? '0vw' : layerPlacement(0, depth, drag, width).x
  const shownList = listOf(state.tab, top, state.notes)
  const offered = !searching && drag === 0 ? newNoteOffered(state.tab, top, shownList) : null
  const attention = licenceRow(licence, now).needsAttention
  const { barHidden } = tabsState(state, searching || covered, attention)

  const releaseKeyboard = () => {
    earlyKeys.current?.fail()
    earlyKeys.current = null
    committedLater.current?.()
    const proxy = keyboardProxy.current
    if (!proxy) return
    if (document.activeElement === proxy) proxy.blur()
    proxy.value = ''
  }

  const leaveNewNote = (id: string) => {
    const note = made.current.get(id)
    made.current.delete(id)
    if (!note) return
    if (!note.handedOver) releaseKeyboard()
    const core = phoneData.core
    const listed = [...phoneData.notes, ...phoneData.templates].find((n) => n.id === id)
    if (!core || note.touched || !untouched(note, listed)) {
      setArrivedId(id)
      return
    }
    setDiscarding((ids) => new Set(ids).add(id))
    void discardNewNote(core, id).then(async (gone) => {
      if (gone) await phoneData.refresh()
      setDiscarding((ids) => without(ids, id))
      if (!gone) setArrivedId(id)
    })
  }

  // Every navigation that can leave a screen comes through here, so a new note left untouched goes with it.
  const go = (action: PhoneNavigationAction) => {
    const next = navigate(latest.current, action)
    for (const id of newNotesLeft(latest.current, next)) leaveNewNote(id)
    latest.current = next
    dispatch(action)
  }

  const newNote = (kind: 'note' | 'template', list: ShownList | null) => {
    const bookId =
      kind === 'template' ? null : newNoteBook(list, editorSettings().defaultNotebook, store.books)
    requireEditing({ op: 'newNote', id: bookId }, () => {
      const core = store.core
      if (!core || making.current) return
      making.current = true
      const from = latest.current
      const fromTop = from.stacks[from.tab].at(-1)?.id
      // WebKit raises the keyboard only for a focus inside the tap: a hidden field holds it until the body can.
      releaseKeyboard()
      const ticket = startEarlyKeys()
      earlyKeys.current = ticket
      keyboardProxy.current?.focus({ preventScroll: true })
      void makeNewNote(core, kind, bookId)
        .then(async (id) => {
          await phoneData.refresh()
          const shown = latest.current
          // The user went elsewhere while the note was made: nobody saw it, so it goes.
          if (shown.tab !== from.tab || shown.stacks[shown.tab].at(-1)?.id !== fromTop) {
            if (earlyKeys.current === ticket) releaseKeyboard()
            if (await discardNewNote(core, id)) await phoneData.refresh()
            return
          }
          made.current.set(id, {
            bookId: kind === 'template' ? TEMPLATES_BOOK_ID : bookId,
            touched: false,
            handedOver: false,
          })
          go({ type: 'newNoteShown', listView: listUnderNewNote(list, kind, bookId), noteId: id })
        })
        .catch((error: unknown) => {
          if (earlyKeys.current === ticket) releaseKeyboard()
          if (!refusedWrite('newNote', error))
            console.warn('W_PHONE_NEW_NOTE_FAILED', errorCode(error))
        })
        .finally(() => {
          making.current = false
        })
    })
  }

  const handOver = (
    id: string,
    typeLater: (keys: readonly EarlyKey[]) => void,
  ): readonly EarlyKey[] | null => {
    const note = made.current.get(id)
    if (!note || note.handedOver) return null
    note.handedOver = true
    earlyKeys.current?.claim(id)
    earlyKeys.current = null
    const keys = takeEarlyKeys(id)
    const proxy = keyboardProxy.current
    if (!proxy) return keys
    if (!composing.current) return [...keys, ...takeProxyText(proxy)]
    // Marked text is not the user's yet: it moves over once the input method commits it.
    const committed = () => {
      cancel()
      typeLater(takeProxyText(proxy))
    }
    const cancel = () => {
      proxy.removeEventListener('compositionend', committed)
      committedLater.current = null
    }
    proxy.addEventListener('compositionend', committed)
    committedLater.current = cancel
    return keys
  }

  const touch = (id: string) => {
    const note = made.current.get(id)
    if (note) note.touched = true
  }

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
      showPane: (pane, anchor) => {
        const settings = latest.current.stacks.settings
        const above = settings[settings.length - 1]
        // Swift asks each time the pane shows: one still drawn keeps what the owner was doing in it.
        const shown =
          settings.length === 2 && above?.screen === 'pane' && above.pane === pane && !anchor
        if (latest.current.tab !== 'settings') {
          leaveTab()
          go({ type: 'selectTab', tab: 'settings' })
        }
        if (shown) return
        go({ type: 'selectTab', tab: 'settings' })
        go({ type: 'push', screen: 'pane', pane, ...(anchor ? { anchor } : {}) })
      },
      notebooks: () => choicesFromTree(buildBookTree(store.books)),
    }
  })
  useEffect(() => {
    if (native)
      bridge.current?.notify({ notice: 'tabs.state', tab: state.tab, barHidden, attention })
  }, [native, state.tab, barHidden, attention])

  /** New Note in a list's capsule, where the native tab bar has taken the circle's corner. */
  const capsuleNewNote = (tab: PhoneTab, route: PhoneRoute) => {
    if (!native) return {}
    const list = listOf(tab, route, state.notes)
    const kind = newNoteOffered(tab, route, list)
    if (!kind) return {}
    return {
      newNote: {
        label: t(kind === 'template' ? 'templates.new' : 'noteList.newNote'),
        onPress: () => newNote(kind, list),
      },
    }
  }

  const pop = () => go({ type: 'pop' })
  const openSearch = (query?: string) => {
    setSearchQuery(query)
    setSearching(true)
  }

  const render = (tab: PhoneTab, route: PhoneRoute) => {
    const index = state.stacks[tab].findIndex((r) => r.id === route.id)
    const onBack = index > 0 ? pop : undefined
    if (route.screen === 'note' && route.noteId) {
      const noteId = route.noteId
      return (
        <PhoneNote
          store={store}
          noteId={noteId}
          onBack={pop}
          onTrash={undoable.trash}
          {...(route.fresh
            ? {
                arrival: {
                  takeTyped: (typeLater) => handOver(noteId, typeLater),
                  onTouched: () => touch(noteId),
                },
              }
            : {})}
        />
      )
    }
    if (route.screen === 'pane' && route.pane)
      return (
        <PhoneSettingsPane
          pane={route.pane}
          focusKey={route.focusKey === true}
          anchor={route.anchor}
          nativeBar={native === true}
          onBack={pop}
        />
      )
    if (tab === 'library' && route.screen === 'root')
      return (
        <PhoneLibrary
          data={store}
          {...capsuleNewNote(tab, route)}
          onShowNotes={(view, status) => go({ type: 'showNotes', view, status })}
          onOpenList={(view) => go({ type: 'push', screen: 'list', view })}
          onSearch={() => openSearch()}
          onSavedSearch={openSearch}
          onNewNotebook={() =>
            requireEditing({ op: 'newNotebook', id: null }, () => {
              const core = store.core
              if (core)
                watchWrite(
                  'newNotebook',
                  core.createBook(t('book.new'), null).then(store.refresh),
                  'W_PHONE_NEW_NOTEBOOK_FAILED',
                )
            })
          }
        />
      )
    if (tab === 'activity')
      return (
        <PhoneActivity
          data={store}
          onOpenNote={(noteId) => go({ type: 'push', screen: 'note', noteId })}
        />
      )
    if (tab === 'settings')
      return <PhoneSettings onOpenPane={(pane) => go({ type: 'push', screen: 'pane', pane })} />
    const view =
      route.screen === 'root' ? state.notes.view : (route.view ?? { kind: 'all' as const })
    return (
      <PhoneNoteList
        data={store}
        {...capsuleNewNote(tab, route)}
        view={view}
        status={route.screen === 'root' ? state.notes.status : 'all'}
        title={viewTitle(view, store)}
        arrivedId={arrivedId}
        {...(onBack ? { onBack } : {})}
        onOpenNote={(noteId) => go({ type: 'push', screen: 'note', noteId })}
        onSearch={() => openSearch()}
        onTrash={undoable.trash}
        onComplete={undoable.complete}
      />
    )
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
          covered={searching}
          drag={tab === state.tab ? drag : 0}
          width={width}
          dragging={dragging}
          render={(route) => render(tab, route)}
        />
      ))}
      {native === false && (
        <>
          <PhoneTabBar
            tab={state.tab}
            x={rootX}
            covered={depth > 0 || searching}
            dragging={dragging}
            needsAttention={attention}
            onSelect={(tab) => {
              if (tab !== state.tab) {
                leaveTab()
                haptic('selection')
              }
              go({ type: 'selectTab', tab })
            }}
          />
          <button
            type="button"
            className="phone-glass phone-compose"
            data-hidden={offered === null || undefined}
            inert={offered === null}
            aria-hidden={offered === null || undefined}
            aria-label={t(offered === 'template' ? 'templates.new' : 'noteList.newNote')}
            onClick={() => {
              if (offered) newNote(offered, shownList)
            }}
          >
            <Icon name="note.new" size="phone-compose" />
          </button>
        </>
      )}
      <textarea
        ref={keyboardProxy}
        className="phone-keyboard-proxy"
        data-keyboard-proxy=""
        aria-hidden="true"
        tabIndex={-1}
        inputMode="text"
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
      />
      <PhoneToast toast={undoable.toast} />
      <PhoneGate
        licence={licence}
        onOpenLicence={(focusKey) => {
          setSearching(false)
          if (native) {
            bridge.current?.notify({ notice: 'settings.open', pane: 'licence', focusKey })
            return
          }
          go({ type: 'selectTab', tab: 'settings' })
          go({ type: 'push', screen: 'pane', pane: 'licence', focusKey })
        }}
      />
      <PhoneSearch
        store={store}
        open={searching}
        query={searchQuery}
        onClose={() => setSearching(false)}
        onOpenNote={(noteId) => {
          setSearching(false)
          go({ type: 'push', screen: 'note', noteId })
        }}
      />
      {depth > 0 && !searching && (
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
