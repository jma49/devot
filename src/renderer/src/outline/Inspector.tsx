import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { current } from '../focus'
import { t } from '../i18n'
import { INSPECTOR_TABS, inspectorTabStore, type InspectorTab } from './inspectorTab'
import type { OutlinePanelProps } from './OutlinePanel'
import type { useOutlineRoom } from './useOutlineRoom'

const OutlinePanel = lazy(() =>
  import('./OutlinePanel').then((module) => ({ default: module.OutlinePanel })),
)

const tabs = INSPECTOR_TABS

/**
 * The window's inspector tab. `show` and `toggleInfo` given a note also move the keyboard to the
 * tab once the inspector has mounted it for that note; a request made without a note, or meant for
 * another note, is dropped and never takes the keyboard later. `toggleInfo` goes back to the tab
 * shown before Info, as the Note Info card closed on a second press.
 */
export function useInspectorTab() {
  const [store] = useState(() => current(inspectorTabStore))
  const [state, setState] = useState<{
    active: InspectorTab
    previous: InspectorTab
    focusFor: string | undefined
  }>(() => {
    const active = store.load()
    return { active, previous: active === 'info' ? 'outline' : active, focusFor: undefined }
  })
  const dropFocus = useCallback(
    () => setState((now) => (now.focusFor === undefined ? now : { ...now, focusFor: undefined })),
    [],
  )
  const go = (tab: InspectorTab, focusFor: string | undefined) => {
    setState((now) => ({
      active: tab,
      previous: now.active === tab ? now.previous : now.active,
      focusFor,
    }))
    store.save(tab)
  }
  return {
    active: state.active,
    focusFor: state.focusFor,
    select: (tab: InspectorTab) => go(tab, undefined),
    show: (tab: InspectorTab, noteId?: string) => go(tab, noteId),
    toggleInfo: (noteId: string) => go(state.active === 'info' ? state.previous : 'info', noteId),
    dropFocus,
  }
}

export function Inspector(props: {
  noteId: string
  room: ReturnType<typeof useOutlineRoom>
  tab: ReturnType<typeof useInspectorTab>
  infoRef?: (el: HTMLDivElement | null) => void
  outline: OutlinePanelProps
  history: ReactNode
  info?: ReactNode
}) {
  const { active, select, focusFor, dropFocus } = props.tab
  useEffect(() => {
    if (focusFor === undefined) return
    if (focusFor === props.noteId) document.getElementById(`inspector-tab-${active}`)?.focus()
    dropFocus()
  }, [focusFor, props.noteId, active, dropFocus])
  const [visited, setVisited] = useState<readonly InspectorTab[]>([active])
  if (!visited.includes(active)) setVisited([...visited, active])
  const labels = {
    outline: t('outline.label'),
    info: t('outline.info'),
    history: t('outline.history'),
  }
  return (
    <aside
      className="inspector"
      style={{ width: props.room.width }}
      aria-label={t('outline.inspector')}
    >
      <div className="inspector-resize" aria-label={t('outline.resize')} {...props.room.edge} />
      <div className="segmented" role="tablist" aria-label={t('outline.tabs')}>
        {tabs.map((tab, i) => (
          <button
            type="button"
            className="segment"
            key={tab}
            role="tab"
            id={`inspector-tab-${tab}`}
            aria-controls={`inspector-panel-${tab}`}
            aria-selected={active === tab}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => select(tab)}
            onKeyDown={(e) => {
              const step = document.dir === 'rtl' ? -1 : 1
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? tabs.length - 1
                    : e.key === 'ArrowLeft'
                      ? i - step
                      : e.key === 'ArrowRight'
                        ? i + step
                        : undefined
              if (next === undefined) return
              e.preventDefault()
              const target = tabs[(next + tabs.length) % tabs.length]!
              select(target)
              document.getElementById(`inspector-tab-${target}`)?.focus()
            }}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab}
          role="tabpanel"
          id={`inspector-panel-${tab}`}
          aria-labelledby={`inspector-tab-${tab}`}
          hidden={tab !== active}
          tabIndex={0}
          ref={tab === 'info' && visited.includes(tab) ? props.infoRef : undefined}
        >
          {visited.includes(tab) ? (
            tab === 'outline' ? (
              <Suspense fallback={null}>
                <OutlinePanel {...props.outline} />
              </Suspense>
            ) : (
              props[tab]
            )
          ) : null}
        </div>
      ))}
    </aside>
  )
}
