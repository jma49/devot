import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { errorCode } from '../backups'
import { Icon } from '../icons/Icon'
import { t } from '../i18n'
import { AppearanceSection } from './AppearanceSection'
import { EditorSection } from './EditorSection'
import { GeneralSection } from './GeneralSection'
import { KeyboardSection } from './KeyboardSection'
import { MirrorSection } from './MirrorSection'
import { currentPaneStore, PANES, PANE_TABS, paneAfterKey, type PaneId } from './panes'
import { UsageSection } from './UsageSection'
import { fitWindow } from './window'

const SECTIONS: Readonly<Record<PaneId, () => React.JSX.Element>> = {
  general: GeneralSection,
  editor: EditorSection,
  appearance: AppearanceSection,
  keyboard: KeyboardSection,
  mirror: MirrorSection,
  usage: UsageSection,
}

/** The tallest the window grows for a pane; a longer pane scrolls. */
const MAX_HEIGHT = 800
/** Room the window leaves on a small screen, for the menu bar and the Dock. */
const SCREEN_MARGIN = 120

/**
 * Fits the window to the toolbar and the pane's content (`fitted` holds the
 * height last asked for); the first fit is at once, later ones animate.
 */
function fitToContent(
  toolbar: HTMLElement | null,
  content: HTMLElement,
  fitted: { current: number | null },
) {
  const natural =
    (toolbar?.getBoundingClientRect().height ?? 0) + content.getBoundingClientRect().height
  const limit = Math.min(MAX_HEIGHT, screen.availHeight - SCREEN_MARGIN)
  const height = Math.ceil(Math.min(natural, limit))
  if (height === fitted.current || height <= 0) return
  const animate = fitted.current !== null
  fitted.current = height
  fitWindow(height, animate).catch((e: unknown) =>
    console.warn('W_SETTINGS_FIT_FAILED', errorCode(e)),
  )
}

const tabId = (pane: PaneId) => `settings-tab-${pane}`
const PANEL_ID = 'settings-pane'

/**
 * The Settings window: a toolbar with a tab per pane (its symbol and name)
 * and the selected pane under it, one at a time. The window fits each pane's
 * height (animated as the pane changes; a pane taller than the screen
 * allows scrolls), and opens on the pane shown last. The toolbar is one tab
 * stop: the arrow keys, Home and End move between the panes, as in a tab
 * list.
 */
export function SettingsWindow() {
  const [store] = useState(currentPaneStore)
  const [pane, setPane] = useState<PaneId>(() => store.read())
  const toolbar = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const tabs = useRef(new Map<PaneId, HTMLButtonElement>())
  const fitted = useRef<number | null>(null)

  const select = (next: PaneId) => {
    setPane(next)
    store.write(next)
    // A new pane starts at its top.
    body.current?.parentElement?.scrollTo({ top: 0 })
  }

  const onToolbarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const next = paneAfterKey(pane, event.key)
    if (next === undefined) return
    event.preventDefault()
    select(next)
    tabs.current.get(next)?.focus()
  }

  // The window fits the toolbar and the pane's content, measured before
  // paint and again whenever the content changes height (another pane, a
  // list shown, an error); the first fit is at once, later ones animate.
  useLayoutEffect(() => {
    const content = body.current
    if (!content) return
    const fit = () => fitToContent(toolbar.current, content, fitted)
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(content)
    return () => observer.disconnect()
  }, [toolbar, body, fitted])

  const Section = SECTIONS[pane]
  return (
    <main className="settings" aria-label={t('settings.title')}>
      <div
        ref={toolbar}
        className="settings-toolbar"
        role="tablist"
        aria-label={t('settings.toolbar')}
        onKeyDown={onToolbarKey}
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
              <Icon name={PANE_TABS[id].icon} size="lg" />
              <span className="settings-tab-label">{t(PANE_TABS[id].label)}</span>
            </button>
          )
        })}
      </div>
      <div id={PANEL_ID} className="settings-pane" role="tabpanel" aria-labelledby={tabId(pane)}>
        <div ref={body} className="settings-pane-body">
          <Section />
        </div>
      </div>
    </main>
  )
}
