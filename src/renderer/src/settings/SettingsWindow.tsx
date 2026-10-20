import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../icons/Icon'
import { t } from '../i18n'
import { AppearanceSection } from './AppearanceSection'
import { EditingSection } from './EditingSection'
import { GeneralSection } from './GeneralSection'
import { IntegrationsSection } from './IntegrationsSection'
import { KeyboardSection } from './KeyboardSection'
import { MirrorSection } from './MirrorSection'
import { currentPaneStore, PANES, PANE_TABS, paneAfterKey, type PaneId } from './panes'
import { PreviewSection } from './PreviewSection'
import { UsageSection } from './UsageSection'

const SECTIONS: Readonly<Record<PaneId, () => React.JSX.Element>> = {
  general: GeneralSection,
  editing: EditingSection,
  preview: PreviewSection,
  appearance: AppearanceSection,
  keyboard: KeyboardSection,
  mirror: MirrorSection,
  integrations: IntegrationsSection,
  usage: UsageSection,
}

const tabId = (pane: PaneId) => `settings-tab-${pane}`
const PANEL_ID = 'settings-pane'

/**
 * The Settings window: a navigation column on the left (a row per pane, its
 * name and its symbol) and the selected pane beside it, one at a time; a
 * pane taller than the window scrolls. It opens on the pane shown last. The
 * column is one tab stop: the Up and Down arrow keys, Home and End move
 * between the panes, as in a vertical tab list.
 */
export function SettingsWindow() {
  const [store] = useState(currentPaneStore)
  const [pane, setPane] = useState<PaneId>(() => store.read())
  const body = useRef<HTMLDivElement>(null)
  const tabs = useRef(new Map<PaneId, HTMLButtonElement>())

  const scrolls = useRef(new Map<PaneId, number>())

  const select = (next: PaneId) => {
    if (next === pane) return
    scrolls.current.set(pane, body.current?.scrollTop ?? 0)
    setPane(next)
    store.write(next)
  }

  useLayoutEffect(() => {
    body.current?.scrollTo({ top: scrolls.current.get(pane) ?? 0 })
  }, [pane])

  const onNavKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const next = paneAfterKey(pane, event.key)
    if (next === undefined) return
    event.preventDefault()
    select(next)
    tabs.current.get(next)?.focus()
  }

  const Section = SECTIONS[pane]
  return (
    <main className="settings" aria-label={t('settings.title')}>
      <div
        className="settings-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('settings.toolbar')}
        onKeyDown={onNavKey}
      >
        {PANES.map((id) => {
          const selected = id === pane
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
              className="settings-tab"
              aria-selected={selected}
              aria-controls={selected ? PANEL_ID : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(id)}
            >
              <span className="settings-tab-label">{t(PANE_TABS[id].label)}</span>
              <Icon name={PANE_TABS[id].icon} size="lg" />
            </button>
          )
        })}
      </div>
      <div
        ref={body}
        id={PANEL_ID}
        className="settings-pane"
        role="tabpanel"
        aria-labelledby={tabId(pane)}
      >
        <div className="settings-pane-body">
          <Section />
        </div>
      </div>
    </main>
  )
}
