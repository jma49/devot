import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Icon } from '../icons/Icon'
import { t } from '../i18n'
import { listenHere, unlistenLater } from '../windowEvents'
import { AiSection } from './AiSection'
import { AppearanceSection } from './AppearanceSection'
import { EditingSection } from './EditingSection'
import { GeneralSection } from './GeneralSection'
import { IntegrationsSection } from './IntegrationsSection'
import { KeyboardSection } from './KeyboardSection'
import { LicenceSection } from './LicenceSection'
import { MirrorSection } from './MirrorSection'
import {
  currentPaneStore,
  isPane,
  PANES,
  PANE_TABS,
  PANE_TILES,
  paneAfterKey,
  paneFromQuery,
  SHOW_PANE,
  type PaneId,
} from './panes'
import { PluginsSection } from './PluginsSection'
import { PreviewSection } from './PreviewSection'
import { searchSettings, type SettingsResult } from './search'
import { searchKey, waitForSetting } from './searchNavigation'
import { isImeKey } from '../ime'
import { SyncSection } from './SyncSection'
import { UsageSection } from './UsageSection'
import { ToolbarEnd } from './toolbar'

/** Rust asks an open Settings window for a pane (Add Licence); re-sent in the page for the UI tests. */
const PANE_EVENT = 'devot://settings-pane'

/** How many panes the toolbar's Back and Forward remember. */
const HISTORY_LIMIT = 30

const SECTIONS: Readonly<Record<PaneId, () => React.JSX.Element>> = {
  general: GeneralSection,
  editing: EditingSection,
  preview: PreviewSection,
  appearance: AppearanceSection,
  keyboard: KeyboardSection,
  mirror: MirrorSection,
  sync: SyncSection,
  ai: AiSection,
  licence: LicenceSection,
  integrations: IntegrationsSection,
  plugins: PluginsSection,
  usage: UsageSection,
}

const tabId = (pane: PaneId) => `settings-tab-${pane}`
const PANEL_ID = 'settings-pane'

/**
 * The Settings window: a toolbar (Back, Forward, the pane's name), a search
 * field and the panes' names with a coloured tile each, and the chosen pane
 * in a scrolling column. The pane is remembered between openings; Back and
 * Forward walk the panes visited in this window. The window has no native
 * title bar: the toolbar drags it, and the traffic lights sit over it.
 */
export function SettingsWindow() {
  const [store] = useState(currentPaneStore)
  const [pane, setPane] = useState<PaneId>(() => paneFromQuery(location.search) ?? store.read())
  const [focused, setFocused] = useState(true)
  const [back, setBack] = useState<PaneId[]>([])
  const [forward, setForward] = useState<PaneId[]>([])
  const [query, setQuery] = useState('')
  const [resultIndex, setResultIndex] = useState(0)
  const [target, setTarget] = useState<{ result: SettingsResult; request: number } | null>(null)
  const targetRequest = useRef(0)
  const [scrolled, setScrolled] = useState(false)
  const [toolbarEnd, setToolbarEnd] = useState<HTMLDivElement | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const scrolls = useRef(new Map<PaneId, number>())
  const tabs = useRef(new Map<PaneId, HTMLButtonElement>())

  /** Shows `next`; a pane change records the one left behind for Back. */
  const show = (next: PaneId, record = true) => {
    setTarget(null)
    if (next === pane) return
    scrolls.current.set(pane, body.current?.scrollTop ?? 0)
    if (record) {
      setBack((stack) => [...stack, pane].slice(-HISTORY_LIMIT))
      setForward([])
    }
    setPane(next)
    store.write(next)
  }

  const goBack = () => {
    setTarget(null)
    const previous = back.at(-1)
    if (previous === undefined) return
    scrolls.current.set(pane, body.current?.scrollTop ?? 0)
    setBack((stack) => stack.slice(0, -1))
    setForward((stack) => [pane, ...stack].slice(0, HISTORY_LIMIT))
    setPane(previous)
    store.write(previous)
  }

  const goForward = () => {
    setTarget(null)
    const next = forward[0]
    if (next === undefined) return
    scrolls.current.set(pane, body.current?.scrollTop ?? 0)
    setForward((stack) => stack.slice(1))
    setBack((stack) => [...stack, pane].slice(-HISTORY_LIMIT))
    setPane(next)
    store.write(next)
  }

  useLayoutEffect(() => {
    body.current?.scrollTo({ top: scrolls.current.get(pane) ?? 0 })
    setScrolled((body.current?.scrollTop ?? 0) > 0)
  }, [pane])

  useLayoutEffect(() => {
    if (!target || !body.current) return
    return waitForSetting(
      body.current,
      target.result.paneLabel ? t(target.result.label) : undefined,
      () => setTarget((current) => (current === target ? null : current)),
      target.result.label,
    )
  }, [target])

  const latestShow = useRef(show)
  useInsertionEffect(() => {
    latestShow.current = show
  })

  useEffect(() => {
    const asked = (e: Event) => {
      const next = (e as CustomEvent).detail
      if (isPane(next)) latestShow.current(next)
    }
    window.addEventListener(SHOW_PANE, asked)
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          listenHere<unknown>(PANE_EVENT, (e) =>
            window.dispatchEvent(new CustomEvent(SHOW_PANE, { detail: e.payload })),
          ),
          () => console.warn('W_SETTINGS_LISTEN_FAILED'),
        )
    return () => {
      window.removeEventListener(SHOW_PANE, asked)
      unlisten?.()
    }
  }, [])

  // A row keeps its solid accent wash while the window has the keyboard; the
  // grey one says the window is behind another.
  useEffect(() => {
    if (DEVOT_UI_TEST) return
    return unlistenLater(
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
        getCurrentWindow().onFocusChanged(({ payload }) => setFocused(payload)),
      ),
      () => console.warn('W_SETTINGS_FOCUS_FAILED'),
    )
  }, [])

  const results = searchSettings(query, t)
  const searching = query.trim() !== ''

  const onNavKey = (event: KeyboardEvent<HTMLElement>) => {
    if (searching || isImeKey(event.nativeEvent)) return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.settings-nav-row')) return
    const next = paneAfterKey(pane, event.key)
    if (next === undefined) return
    event.preventDefault()
    show(next)
    tabs.current.get(next)?.focus()
  }

  const openResult = (result: SettingsResult) => {
    show(result.pane)
    setTarget({ result, request: ++targetRequest.current })
    setQuery('')
    setResultIndex(0)
  }

  const onSearchKey = (event: KeyboardEvent<HTMLElement>) => {
    const action = searchKey(event.nativeEvent, resultIndex, results.length)
    if (!action) return
    event.preventDefault()
    if (action.type === 'clear') {
      setTarget(null)
      setQuery('')
      setResultIndex(0)
    } else if (action.type === 'open') openResult(results[action.index]!)
    else {
      setResultIndex(action.index)
      if (event.currentTarget !== event.target || event.target instanceof HTMLButtonElement) {
        document.getElementById(`settings-result-${action.index}`)?.focus()
      }
      document
        .getElementById(`settings-result-${action.index}`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }

  const Section = SECTIONS[pane]
  return (
    <main className="settings" aria-label={t('settings.title')} data-focused={focused || undefined}>
      <nav
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('settings.toolbar')}
        onKeyDown={onNavKey}
      >
        <div className="settings-search">
          <Icon name="search" size="sm" />
          <input
            type="search"
            className="settings-search-field"
            aria-label={t('settings.search')}
            placeholder={t('settings.search')}
            value={query}
            aria-controls={searching ? 'settings-results' : undefined}
            aria-activedescendant={
              searching && results.length ? `settings-result-${resultIndex}` : undefined
            }
            onChange={(e) => {
              setTarget(null)
              setQuery(e.target.value)
              setResultIndex(0)
            }}
            onKeyDown={onSearchKey}
          />
        </div>
        {searching ? (
          <div
            id="settings-results"
            className="settings-results"
            role="listbox"
            aria-label={t('settings.results')}
            onKeyDown={onSearchKey}
          >
            {results.length === 0 ? (
              <p className="settings-no-results">{t('settings.noResults')}</p>
            ) : (
              results.map((result, index) => {
                const tile = PANE_TILES[result.pane]
                return (
                  <button
                    key={`${result.pane}:${result.label}`}
                    type="button"
                    id={`settings-result-${index}`}
                    role="option"
                    aria-selected={index === resultIndex}
                    onFocus={() => setResultIndex(index)}
                    className="settings-nav-row settings-result"
                    onClick={() => openResult(result)}
                  >
                    <span
                      className="settings-nav-tile"
                      style={{
                        background: tile.color,
                        color: tile.foreground ?? 'var(--color-icon-tile-foreground)',
                      }}
                    >
                      <Icon name={tile.icon} size="sm" weight="semibold" />
                    </span>
                    <span className="settings-nav-label">{t(result.label)}</span>
                    {result.paneLabel ? (
                      <span className="settings-result-pane">{t(result.paneLabel)}</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        ) : (
          PANES.map((id) => {
            const selected = id === pane
            const tile = PANE_TILES[id]
            return (
              <button
                key={id}
                ref={(button) => {
                  if (button) tabs.current.set(id, button)
                  else tabs.current.delete(id)
                }}
                id={tabId(id)}
                type="button"
                role="tab"
                className="settings-nav-row"
                aria-selected={selected}
                aria-controls={selected ? PANEL_ID : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => show(id)}
              >
                <span
                  className="settings-nav-tile"
                  style={{
                    background: tile.color,
                    color: tile.foreground ?? 'var(--color-icon-tile-foreground)',
                  }}
                >
                  <Icon name={tile.icon} size="sm" weight="semibold" />
                </span>
                <span className="settings-nav-label">{t(PANE_TABS[id].label)}</span>
              </button>
            )
          })
        )}
      </nav>
      <div className="settings-main">
        <header
          className="settings-toolbar"
          data-tauri-drag-region
          data-scrolled={scrolled || undefined}
        >
          <div className="settings-history" role="group" aria-label={t('settings.history')}>
            <button
              type="button"
              className="settings-history-button"
              data-tauri-drag-region="false"
              aria-label={t('settings.back')}
              title={t('settings.back')}
              disabled={back.length === 0}
              onClick={goBack}
            >
              <Icon name="settings.back" size="sm" weight="semibold" />
            </button>
            <span className="settings-history-divider" aria-hidden="true" />
            <button
              type="button"
              className="settings-history-button"
              data-tauri-drag-region="false"
              aria-label={t('settings.forward')}
              title={t('settings.forward')}
              disabled={forward.length === 0}
              onClick={goForward}
            >
              <Icon name="settings.forward" size="sm" weight="semibold" />
            </button>
          </div>
          <h1 id="settings-pane-title" className="settings-title">
            {t(PANE_TABS[pane].label)}
          </h1>
          <div ref={setToolbarEnd} className="settings-toolbar-end" />
        </header>
        <div
          ref={body}
          id={PANEL_ID}
          className="settings-pane"
          role="tabpanel"
          aria-labelledby="settings-pane-title"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          <div key={pane} className="settings-pane-body">
            <ToolbarEnd.Provider value={toolbarEnd}>
              <Section />
            </ToolbarEnd.Provider>
          </div>
        </div>
      </div>
    </main>
  )
}
