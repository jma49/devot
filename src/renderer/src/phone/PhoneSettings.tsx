import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { useLicence } from '../licence'
import { OnPhone } from '../settings/onPhone'
import { PANE_TABS, PANE_TILES, type PaneId } from '../settings/panes'
import { doveMask } from './dove'
import { licenceRow } from './settingsRows'

interface Row {
  readonly pane: PaneId
  readonly value?: string
  readonly alert?: boolean
  /** Shown but not opened on the phone: the feature lives on the Mac for now. */
  readonly macOnly?: boolean
}

function SettingsRow(props: { row: Row; onOpen: (pane: PaneId) => void }) {
  const { row } = props
  const tile = PANE_TILES[row.pane]
  return (
    <li className="phone-grouped-row">
      <button
        type="button"
        className="phone-grouped-open"
        disabled={row.macOnly}
        onClick={() => props.onOpen(row.pane)}
      >
        <span
          className="phone-row-tile"
          style={{ background: tile.color, ...(tile.foreground ? { color: tile.foreground } : {}) }}
        >
          <Icon name={tile.icon} size="sm" />
        </span>
        <span className="phone-grouped-label">{t(PANE_TABS[row.pane].label)}</span>
        {row.alert && (
          <span className="phone-alert-badge" aria-label={t('phone.badge.attention')}>
            !
          </span>
        )}
        {(row.value || row.macOnly) && (
          <span className="phone-grouped-count">
            {row.macOnly ? t('phone.settings.onMac') : row.value}
          </span>
        )}
        {!row.macOnly && (
          <span className="phone-chevron">
            <Icon name="phone.disclosure" size="xs" />
          </span>
        )}
      </button>
    </li>
  )
}

function useVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (DEVOT_UI_TEST) return
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(setVersion)
      .catch(() => console.warn('W_PHONE_VERSION_FAILED'))
  }, [])
  return version
}

export function PhoneSettings(props: { onOpenPane: (pane: PaneId) => void }) {
  const licence = useLicence()
  const version = useVersion()
  const [now] = useState(() => Date.now())
  const state = licenceRow(licence, now)
  const groups: readonly (readonly Row[])[] = [
    [{ pane: 'licence', value: state.label, alert: state.needsAttention }],
    [{ pane: 'sync' }, { pane: 'mirror', macOnly: true }],
    [
      { pane: 'general' },
      { pane: 'appearance' },
      { pane: 'editing' },
      { pane: 'preview' },
      { pane: 'keyboard' },
    ],
    [
      { pane: 'ai' },
      { pane: 'integrations', macOnly: true },
      { pane: 'plugins', macOnly: true },
      { pane: 'usage' },
    ],
  ]
  const summary = version ? `${version} · ${state.label}` : state.label
  return (
    <section aria-label={t('settings.title')} className="phone-screen" data-surface="group">
      <div className="phone-scroll phone-settings">
        <div className="phone-settings-head">
          <span className="phone-app-icon">
            <span
              role="img"
              aria-label={t('phone.settings.appName')}
              className="phone-dove phone-dove-large"
              style={doveMask}
            />
          </span>
          <span className="phone-settings-name">{t('phone.settings.appName')}</span>
          <span className="phone-settings-version">{summary}</span>
        </div>
        {groups.map((rows) => (
          <ul key={rows[0]!.pane} className="phone-card">
            {rows.map((row) => (
              <SettingsRow key={row.pane} row={row} onOpen={props.onOpenPane} />
            ))}
          </ul>
        ))}
      </div>
      <div aria-hidden="true" className="phone-edge" />
      <header className="phone-topbar">
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('phone.settings.pair')}
          onClick={() => props.onOpenPane('sync')}
        >
          <Icon name="phone.pair" size="lg" />
        </button>
        <h1 className="phone-topbar-title">{t('settings.title')}</h1>
        <span className="phone-topbar-spacer" />
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('settings.search')}
          disabled
        >
          <Icon name="search" size="lg" />
        </button>
      </header>
    </section>
  )
}

const PANE_SECTIONS: Readonly<Partial<Record<PaneId, () => Promise<() => React.JSX.Element>>>> = {
  general: () => import('../settings/GeneralSection').then((m) => m.GeneralSection),
  appearance: () => import('../settings/AppearanceSection').then((m) => m.AppearanceSection),
  editing: () => import('../settings/EditingSection').then((m) => m.EditingSection),
  preview: () => import('../settings/PreviewSection').then((m) => m.PreviewSection),
  keyboard: () => import('../settings/KeyboardSection').then((m) => m.KeyboardSection),
  sync: () => import('../settings/SyncSection').then((m) => m.SyncSection),
  ai: () => import('../settings/AiSection').then((m) => m.AiSection),
  licence: () => import('../settings/LicenceSection').then((m) => m.LicenceSection),
  usage: () => import('../settings/UsageSection').then((m) => m.UsageSection),
}

/** An existing Settings pane, in a phone screen of its own. */
export function PhoneSettingsPane(props: { pane: string; onBack: () => void }) {
  const pane = props.pane as PaneId
  const [Section, setSection] = useState<(() => React.JSX.Element) | null>(null)
  useEffect(() => {
    let alive = true
    void PANE_SECTIONS[pane]?.()
      .then((loaded) => alive && setSection(() => loaded))
      .catch(() => console.warn('W_PHONE_PANE_FAILED'))
    return () => {
      alive = false
    }
  }, [pane])
  const title = PANE_TABS[pane] ? t(PANE_TABS[pane].label) : t('settings.title')
  return (
    <section aria-label={title} className="phone-screen" data-surface="group">
      <div className="phone-scroll phone-settings-pane settings-window">
        <OnPhone.Provider value={true}>{Section && <Section />}</OnPhone.Provider>
      </div>
      <div aria-hidden="true" className="phone-edge" />
      <header className="phone-topbar">
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('phone.back')}
          onClick={props.onBack}
        >
          <Icon name="nav.back" size="lg" />
        </button>
        <h1 className="phone-topbar-title">{title}</h1>
      </header>
    </section>
  )
}
