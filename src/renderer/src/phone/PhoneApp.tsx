import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { motionMs } from '../motionTiming'
import { motionReduced } from '../motionPreference'
import {
  initialNavigation,
  layerPlacement,
  navigate,
  PHONE_TABS,
  releasePops,
  releaseSpeed,
  type PhoneRoute,
  type PhoneTab,
} from './navigation'
import { startPhoneRoot } from './spring'
import type { PhoneView } from './library'
import { PhoneActivity } from './PhoneActivity'
import { PhoneLibrary } from './PhoneLibrary'
import { usePhoneData, type PhoneData } from './usePhoneData'
import { haptic } from './haptics'
import { startLicence, useLicence } from '../licence'
import { licenceRow } from './settingsRows'
import { PhoneCapture } from './PhoneCapture'
import { applyGlassPrefs } from './glassPrefs'
import { PhoneNote } from './PhoneNote'
import { PhoneNoteList } from './PhoneNoteList'
import { PhoneSearch } from './PhoneSearch'
import { PhoneToast, useUndoToast } from './PhoneToast'
import { PhoneSettings, PhoneSettingsPane } from './PhoneSettings'
import './phone.css'

const TAB_LABEL: Record<PhoneTab, MessageKey> = {
  notes: 'phone.tab.notes',
  library: 'phone.tab.library',
  activity: 'phone.tab.activity',
  settings: 'phone.tab.settings',
}

const TAB_ICON: Record<PhoneTab, { rest: IconName; selected: IconName }> = {
  notes: { rest: 'phone.tab.notes', selected: 'phone.tab.notes.fill' },
  library: { rest: 'phone.tab.library', selected: 'phone.tab.library.fill' },
  activity: { rest: 'phone.tab.activity', selected: 'phone.tab.activity.fill' },
  settings: { rest: 'phone.tab.settings', selected: 'phone.tab.settings.fill' },
}

function TabBar(props: {
  tab: PhoneTab
  x: string
  covered: boolean
  dragging: boolean
  needsAttention: boolean
  onSelect: (tab: PhoneTab) => void
}) {
  const [moves, setMoves] = useState(0)
  const index = PHONE_TABS.indexOf(props.tab)
  return (
    <nav
      aria-label={t('phone.tabs')}
      className="phone-glass phone-tabbar"
      data-dragging={props.dragging || undefined}
      inert={props.covered}
      style={{ transform: `translateX(${props.x})` }}
    >
      <span
        aria-hidden="true"
        className="phone-tabbar-lens"
        data-move={moves === 0 ? undefined : moves % 2 ? 'a' : 'b'}
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {PHONE_TABS.map((tab) => {
        const selected = tab === props.tab
        const attention = tab === 'settings' && props.needsAttention
        return (
          <button
            key={tab}
            type="button"
            className="phone-tab"
            aria-label={t(TAB_LABEL[tab])}
            aria-current={selected ? 'page' : undefined}
            onClick={() => {
              if (!selected) setMoves((n) => n + 1)
              props.onSelect(tab)
            }}
          >
            <span
              className="phone-tab-icon"
              data-move={selected && moves > 0 ? (moves % 2 ? 'a' : 'b') : undefined}
            >
              <Icon
                name={selected ? TAB_ICON[tab].selected : TAB_ICON[tab].rest}
                size="phone-tab"
              />
              {attention && (
                <span className="phone-badge" role="img" aria-label={t('phone.badge.attention')}>
                  !
                </span>
              )}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

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
  const start = useRef<{ x: number; lastX: number; lastTime: number; speed: number } | null>(null)
  const move = (event: PointerEvent) => {
    const swipe = start.current
    if (!swipe) return
    const elapsed = event.timeStamp - swipe.lastTime
    if (elapsed > 0) swipe.speed = (event.clientX - swipe.lastX) / elapsed
    swipe.lastX = event.clientX
    swipe.lastTime = event.timeStamp
    props.onMove(Math.max(0, event.clientX - swipe.x))
  }
  const end = (event: PointerEvent) => {
    const swipe = start.current
    if (!swipe) return
    start.current = null
    props.onRelease(
      event.type === 'pointerup' &&
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
        event.currentTarget.setPointerCapture(event.pointerId)
        start.current = {
          x: event.clientX,
          lastX: event.clientX,
          lastTime: event.timeStamp,
          speed: 0,
        }
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
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

export function PhoneApp() {
  const [state, dispatch] = useReducer(navigate, undefined, initialNavigation)
  const store = usePhoneData()
  const [drag, setDrag] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [arrivedId, setArrivedId] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const licence = useLicence()
  const undoable = useUndoToast(store)
  const [now] = useState(() => Date.now())
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => (root.current ? startPhoneRoot(root.current) : undefined), [])
  useEffect(() => startLicence(), [])
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
  const listed = top.screen === 'list' || (state.tab === 'notes' && top.screen === 'root')
  const topView =
    top.screen === 'list' ? top.view : state.tab === 'notes' ? state.notes.view : undefined
  const captureHere =
    !searching &&
    drag === 0 &&
    (listed || (state.tab === 'library' && top.screen === 'root')) &&
    topView?.kind !== 'trash' &&
    topView?.kind !== 'templates'
  const listsNewNote = listed && (topView?.kind === 'all' || topView?.kind === 'book')
  const pop = () => dispatch({ type: 'pop' })
  const openSearch = () => setSearching(true)

  const render = (tab: PhoneTab, route: PhoneRoute) => {
    const index = state.stacks[tab].findIndex((r) => r.id === route.id)
    const onBack = index > 0 ? pop : undefined
    if (route.screen === 'note' && route.noteId)
      return <PhoneNote store={store} noteId={route.noteId} onBack={pop} onTrash={undoable.trash} />
    if (route.screen === 'pane' && route.pane)
      return <PhoneSettingsPane pane={route.pane} onBack={pop} />
    if (tab === 'library' && route.screen === 'root')
      return (
        <PhoneLibrary
          data={store}
          onShowNotes={(view, status) => dispatch({ type: 'showNotes', view, status })}
          onOpenList={(view) => dispatch({ type: 'push', screen: 'list', view })}
          onSearch={openSearch}
          onNewNotebook={() => {
            void store.core
              ?.createBook(t('book.new'), null)
              .then(store.refresh)
              .catch(() => console.warn('W_PHONE_NEW_NOTEBOOK_FAILED'))
          }}
        />
      )
    if (tab === 'activity')
      return (
        <PhoneActivity
          data={store}
          onOpenNote={(noteId) => dispatch({ type: 'push', screen: 'note', noteId })}
        />
      )
    if (tab === 'settings')
      return (
        <PhoneSettings onOpenPane={(pane) => dispatch({ type: 'push', screen: 'pane', pane })} />
      )
    const view =
      route.screen === 'root' ? state.notes.view : (route.view ?? { kind: 'all' as const })
    return (
      <PhoneNoteList
        data={store}
        view={view}
        status={route.screen === 'root' ? state.notes.status : 'all'}
        title={viewTitle(view, store)}
        arrivedId={arrivedId}
        {...(onBack ? { onBack } : {})}
        onOpenNote={(noteId) => dispatch({ type: 'push', screen: 'note', noteId })}
        onSearch={openSearch}
        onTrash={undoable.trash}
        onComplete={undoable.complete}
      />
    )
  }

  useLayoutEffect(applyGlassPrefs, [])

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
      <TabBar
        tab={state.tab}
        x={rootX}
        covered={depth > 0 || searching}
        dragging={dragging}
        needsAttention={licenceRow(licence, now).needsAttention}
        onSelect={(tab) => {
          if (tab !== state.tab) haptic('selection')
          dispatch({ type: 'selectTab', tab })
        }}
      />
      <PhoneCapture
        store={store}
        available={captureHere}
        bookId={topView?.kind === 'book' ? topView.id : null}
        onSaved={(id) => {
          if (!listsNewNote) dispatch({ type: 'showNotes', view: { kind: 'all' }, status: 'all' })
          setArrivedId(id)
          haptic('soft')
        }}
      />
      <PhoneToast toast={undoable.toast} />
      <PhoneSearch
        store={store}
        open={searching}
        onClose={() => setSearching(false)}
        onOpenNote={(noteId) => {
          setSearching(false)
          dispatch({ type: 'push', screen: 'note', noteId })
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
