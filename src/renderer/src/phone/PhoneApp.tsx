import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { format, t, type MessageKey } from '../i18n'
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
import { PhoneLibrary } from './PhoneLibrary'
import { usePhoneData, type PhoneData } from './usePhoneData'
import './phone.css'

const TAB_LABEL: Record<PhoneTab, MessageKey> = {
  notes: 'phone.tab.notes',
  library: 'phone.tab.library',
  settings: 'phone.tab.settings',
}

const TAB_ICON: Record<PhoneTab, { rest: IconName; selected: IconName }> = {
  notes: { rest: 'phone.tab.notes', selected: 'phone.tab.notes.fill' },
  library: { rest: 'phone.tab.library', selected: 'phone.tab.library.fill' },
  settings: { rest: 'phone.tab.settings', selected: 'phone.tab.settings.fill' },
}

function TabBar(props: {
  tab: PhoneTab
  x: string
  covered: boolean
  dragging: boolean
  proposals: number
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
        const badge =
          tab === 'notes' && props.proposals > 0
            ? {
                text: String(props.proposals),
                label: format(t('phone.badge.proposals'), { count: String(props.proposals) }),
              }
            : tab === 'settings' && props.needsAttention
              ? { text: '!', label: t('phone.badge.attention') }
              : null
        return (
          <button
            key={tab}
            type="button"
            className="phone-tab"
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
              <Icon name={selected ? TAB_ICON[tab].selected : TAB_ICON[tab].rest} size="lg" />
              {badge && (
                <span className="phone-badge" aria-label={badge.label}>
                  {badge.text}
                </span>
              )}
            </span>
            {t(TAB_LABEL[tab])}
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

export function PhoneScreen(props: {
  title: string
  surface: 'plain' | 'group'
  onBack?: () => void
  children?: ReactNode
}) {
  return (
    <section aria-label={props.title} className="phone-screen" data-surface={props.surface}>
      <div className="phone-scroll">{props.children}</div>
      <div aria-hidden="true" className="phone-edge" />
      <header className="phone-topbar">
        {props.onBack && (
          <button
            type="button"
            className="phone-glass phone-nav-control"
            aria-label={t('phone.back')}
            onClick={props.onBack}
          >
            <Icon name="nav.back" size="lg" />
          </button>
        )}
        <h1 className="phone-topbar-title">{props.title}</h1>
      </header>
    </section>
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

function PlaceholderScreen(props: {
  route: PhoneRoute
  tab: PhoneTab
  depth: number
  title: string
  onPush: (screen: 'note') => void
  onBack: () => void
}) {
  const { screen } = props.route
  const title =
    screen === 'note' ? t('phone.note') : screen === 'list' ? props.title : t(TAB_LABEL[props.tab])
  const next = screen === 'note' || props.tab === 'settings' ? null : 'note'
  return (
    <PhoneScreen
      title={title}
      surface={screen === 'root' && props.tab !== 'notes' ? 'group' : 'plain'}
      {...(props.depth > 0 ? { onBack: props.onBack } : {})}
    >
      {next && (
        <button type="button" className="phone-row" onClick={() => props.onPush(next)}>
          {t('phone.note')}
        </button>
      )}
    </PhoneScreen>
  )
}

export function PhoneApp() {
  const [state, dispatch] = useReducer(navigate, undefined, initialNavigation)
  const data = usePhoneData()
  const [drag, setDrag] = useState(0)
  const [dragging, setDragging] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => (root.current ? startPhoneRoot(root.current) : undefined), [])

  const width = window.innerWidth
  const depth = state.stacks[state.tab].length - 1
  const rootX = depth === 0 ? '0vw' : layerPlacement(0, depth, drag, width).x

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
          render={(route) =>
            tab === 'library' && route.screen === 'root' ? (
              <PhoneLibrary
                data={data}
                onShowNotes={(view, status) => dispatch({ type: 'showNotes', view, status })}
                onOpenList={(view) => dispatch({ type: 'push', screen: 'list', view })}
                onNewNotebook={() => {
                  void data.core
                    ?.createBook(t('book.new'), null)
                    .then(data.refresh)
                    .catch(() => console.warn('W_PHONE_NEW_NOTEBOOK_FAILED'))
                }}
              />
            ) : (
              <PlaceholderScreen
                route={route}
                tab={tab}
                depth={state.stacks[tab].findIndex((r) => r.id === route.id)}
                title={viewTitle(route.screen === 'root' ? state.notes.view : route.view, data)}
                onPush={(screen) => dispatch({ type: 'push', screen })}
                onBack={() => dispatch({ type: 'pop' })}
              />
            )
          }
        />
      ))}
      <TabBar
        tab={state.tab}
        x={rootX}
        covered={depth > 0}
        dragging={dragging}
        proposals={0}
        needsAttention={false}
        onSelect={(tab) => dispatch({ type: 'selectTab', tab })}
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
            if (pops) dispatch({ type: 'pop' })
          }}
        />
      )}
    </div>
  )
}
