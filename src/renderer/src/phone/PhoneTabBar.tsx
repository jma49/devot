import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import type { IconName } from '../icons/symbols'
import { sizes } from '../theme/tokens'
import { PHONE_TABS, type PhoneTab } from './navigation'
import { dragStarted, fingerSpan, nearestTab, restingSpan, type Span } from './tabLens'
import { startTabLens, type TabLens } from './tabLensMotion'

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

const INSET = Number.parseFloat(sizes['size.phone-lens-inset'])

interface Press {
  readonly pointer: number
  readonly x: number
  readonly y: number
  readonly left: number
  readonly width: number
  readonly height: number
  dragging: boolean
}

export function PhoneTabBar(props: {
  tab: PhoneTab
  x: string
  covered: boolean
  dragging: boolean
  needsAttention: boolean
  onSelect: (tab: PhoneTab) => void
}) {
  const [moves, setMoves] = useState(0)
  const [lifted, setLifted] = useState(false)
  const barRef = useRef<HTMLElement>(null)
  const lensRef = useRef<HTMLSpanElement>(null)
  const press = useRef<Press | null>(null)
  const endPress = useRef<(() => void) | null>(null)
  const swallowClick = useRef(false)
  const index = PHONE_TABS.indexOf(props.tab)
  const lens = useRef<TabLens | null>(null)
  const [firstIndex] = useState(index)
  const aim = (span: Span) => lens.current?.aim(span)

  const select = (tab: PhoneTab) => {
    if (tab !== props.tab) setMoves((n) => n + 1)
    props.onSelect(tab)
  }

  const spanAt = (at: Press, clientX: number) =>
    fingerSpan(
      { width: at.width, height: at.height, inset: INSET, count: PHONE_TABS.length },
      clientX - at.left,
    )

  // A gesture's own click, if any, comes in the task of its pointerup: swallow only that one.
  const swallowGestureClick = (released: boolean) => {
    swallowClick.current = true
    const forget = () =>
      setTimeout(() => {
        swallowClick.current = false
      })
    if (released) forget()
    else window.addEventListener('pointerup', forget, { capture: true, once: true })
  }

  // `clientX` is null for a cancelled press; `released` says whether the finger is already up.
  const finish = (pointer: number, clientX: number | null, released: boolean) => {
    const at = press.current
    if (!at || at.pointer !== pointer) return
    press.current = null
    endPress.current?.()
    endPress.current = null
    setLifted(false)
    lens.current?.lift(false)
    if (at.dragging || clientX === null) swallowGestureClick(released)
    const bar = barRef.current
    if (bar?.hasPointerCapture(pointer)) bar.releasePointerCapture(pointer)
    if (at.dragging && clientX !== null) {
      const tab = PHONE_TABS[nearestTab(spanAt(at, clientX), PHONE_TABS.length)]!
      aim(restingSpan(PHONE_TABS.indexOf(tab)))
      if (tab !== props.tab) select(tab)
      return
    }
    aim(restingSpan(index))
  }
  const latestFinish = useRef(finish)
  useLayoutEffect(() => {
    latestFinish.current = finish
  })

  useLayoutEffect(() => {
    const started = startTabLens(barRef.current!, lensRef.current!, firstIndex, () => {
      if (press.current) latestFinish.current(press.current.pointer, null, false)
    })
    lens.current = started
    return started.stop
  }, [firstIndex])

  useLayoutEffect(() => {
    if (!press.current) lens.current?.aim(restingSpan(index))
  }, [index])

  useEffect(() => () => endPress.current?.(), [])

  return (
    <nav
      ref={barRef}
      aria-label={t('phone.tabs')}
      className="phone-glass phone-tabbar"
      data-dragging={props.dragging || undefined}
      inert={props.covered}
      style={{ transform: `translateX(${props.x})` }}
      onClickCapture={(event) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        if (event.detail === 0) return
        event.stopPropagation()
        event.preventDefault()
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0 || press.current) return
        const box = event.currentTarget.getBoundingClientRect()
        const at: Press = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          left: box.left,
          width: event.currentTarget.offsetWidth,
          height: event.currentTarget.offsetHeight,
          dragging: false,
        }
        press.current = at
        swallowClick.current = false
        const up = (e: globalThis.PointerEvent) =>
          latestFinish.current(e.pointerId, e.clientX, true)
        const cancel = (e: globalThis.PointerEvent) => latestFinish.current(e.pointerId, null, true)
        window.addEventListener('pointerup', up, true)
        window.addEventListener('pointercancel', cancel, true)
        endPress.current = () => {
          window.removeEventListener('pointerup', up, true)
          window.removeEventListener('pointercancel', cancel, true)
        }
        setLifted(true)
        lens.current?.lift(true)
        aim(restingSpan(nearestTab(spanAt(at, event.clientX), PHONE_TABS.length)))
      }}
      onPointerMove={(event) => {
        const at = press.current
        if (!at || at.pointer !== event.pointerId) return
        if (!at.dragging) {
          if (!dragStarted(event.clientX - at.x, event.clientY - at.y)) return
          at.dragging = true
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        aim(spanAt(at, event.clientX))
      }}
      onLostPointerCapture={(event) => finish(event.pointerId, null, false)}
    >
      <span
        ref={lensRef}
        aria-hidden="true"
        className="phone-tabbar-lens"
        data-lifted={lifted || undefined}
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
            onClick={() => select(tab)}
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
