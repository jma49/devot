import { useEffect, useState } from 'react'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { trialRunning, useLicence } from '../licence'
import { OnPhone, ShowHint, type SettingHint } from '../settings/onPhone'
import type { IconName } from '../icons/symbols'
import { PANES, PANE_TABS, type PaneId } from '../settings/panes'
import { startSyncStatus, useSyncSnapshot } from '../sync'
import { doveMask } from './dove'
import { useGlassPrefs } from './glassPrefs'
import { PhoneDetailSheet } from './PhoneSheet'
import { licenceRow, paneMatches } from './settingsRows'

interface Row {
  readonly pane?: PaneId
  readonly label: MessageKey
  readonly icon: IconName
  readonly value?: string
  readonly alert?: boolean
}

const PANE_ICONS: Readonly<Record<PaneId, IconName>> = {
  general: 'phone.settings.general',
  appearance: 'phone.settings.appearance',
  editing: 'phone.settings.editing',
  preview: 'phone.settings.preview',
  keyboard: 'phone.settings.keyboard',
  mirror: 'phone.settings.mirror',
  sync: 'phone.settings.sync',
  ai: 'phone.settings.ai',
  integrations: 'phone.settings.integrations',
  plugins: 'phone.settings.plugins',
  usage: 'phone.settings.usage',
  licence: 'phone.settings.licence',
}

const paneRow = (pane: PaneId, value?: string, alert?: boolean): Row => ({
  pane,
  label: PANE_TABS[pane].label,
  icon: PANE_ICONS[pane],
  ...(value === undefined ? {} : { value }),
  ...(alert === undefined ? {} : { alert }),
})

const macRow = (pane: PaneId): Row => ({
  label: PANE_TABS[pane].label,
  icon: PANE_ICONS[pane],
})

const HTTP_API_ROW: Row = { label: 'httpApi.title', icon: 'phone.settings.api' }

/** The panes that open on a phone, the ones Settings' search can find. */
const OPEN_PANES: readonly PaneId[] = PANES.filter(
  (pane) => pane !== 'mirror' && pane !== 'integrations' && pane !== 'plugins',
)

function SettingsRow(props: { row: Row; onOpen: (pane: PaneId) => void }) {
  const { row } = props
  const onMac = row.pane === undefined
  return (
    <li className="phone-grouped-row">
      <button
        type="button"
        className="phone-grouped-open"
        disabled={onMac}
        onClick={() => row.pane && props.onOpen(row.pane)}
      >
        <span className="phone-row-icon">
          <Icon name={row.icon} size="phone-row" />
        </span>
        <span className="phone-grouped-label">{t(row.label)}</span>
        {row.alert && (
          <span className="phone-alert-badge" aria-label={t('phone.badge.attention')}>
            !
          </span>
        )}
        {(row.value || onMac) && (
          <span className="phone-grouped-count">
            {onMac ? t('phone.settings.onMac') : row.value}
          </span>
        )}
        {!onMac && (
          <span className="phone-chevron">
            <Icon name="phone.disclosure" size="xs" weight="medium" />
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

function SettingsSearch(props: { onOpen: (pane: PaneId) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const found = paneMatches(
    OPEN_PANES.map((pane) => ({ pane, name: t(PANE_TABS[pane].label) })),
    query,
  )
  return (
    <div className="phone-settings-search">
      <div className="phone-scroll phone-settings">
        {found.length > 0 ? (
          <ul className="phone-card">
            {found.map(({ pane }) => (
              <SettingsRow key={pane} row={paneRow(pane)} onOpen={props.onOpen} />
            ))}
          </ul>
        ) : (
          <p className="phone-settings-empty">{t('phone.settings.noResults')}</p>
        )}
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <label className="phone-glass phone-search-field">
          <span className="phone-search-field-icon">
            <Icon name="search" size="md" />
          </span>
          <input
            autoFocus
            type="search"
            className="phone-search-input"
            aria-label={t('settings.search')}
            placeholder={t('settings.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="phone-glass phone-nav-control"
          aria-label={t('phone.settings.closeSearch')}
          onClick={props.onClose}
        >
          <Icon name="phone.close" size="lg" />
        </button>
      </header>
    </div>
  )
}

export function PhoneSettings(props: { onOpenPane: (pane: PaneId) => void }) {
  const licence = useLicence()
  const version = useVersion()
  const sync = useSyncSnapshot()
  const glass = useGlassPrefs()
  const [now] = useState(() => Date.now())
  const [searching, setSearching] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  useEffect(() => startSyncStatus(), [])
  const state = licenceRow(licence, now)
  const trialEnds = licence.trial?.endsAt ?? null
  const groups: readonly { title?: MessageKey; rows: readonly Row[] }[] = [
    {
      title: 'phone.settings.group.general',
      rows: [
        paneRow('general'),
        paneRow(
          'appearance',
          t(glass.style === 'glass' ? 'phone.appearance.glass' : 'phone.appearance.classic'),
        ),
        paneRow('editing'),
        paneRow('preview'),
        paneRow('keyboard'),
      ],
    },
    {
      title: 'phone.settings.group.sync',
      rows: [
        paneRow('sync', t(sync.enabled ? 'phone.settings.on' : 'phone.settings.off')),
        macRow('mirror'),
      ],
    },
    {
      title: 'phone.settings.group.ai',
      rows: [paneRow('ai'), macRow('integrations'), HTTP_API_ROW, macRow('plugins')],
    },
    { rows: [paneRow('usage'), paneRow('licence', state.label, state.needsAttention)] },
  ]
  const summary = version ? `${version} · ${state.label}` : state.label
  return (
    <section aria-label={t('settings.title')} className="phone-screen">
      <div className="phone-scroll phone-settings">
        <ul className="phone-card">
          <li className="phone-grouped-row">
            <button
              type="button"
              className="phone-grouped-open phone-app-row"
              onClick={() => {
                if (trialRunning(licence, now) && trialEnds !== null) setTrialOpen(true)
                else props.onOpenPane('licence')
              }}
            >
              <span className="phone-app-icon">
                <span
                  role="img"
                  aria-label={t('phone.settings.appName')}
                  className="phone-dove"
                  style={doveMask}
                />
              </span>
              <span className="phone-app-text">
                <span className="phone-settings-name">{t('phone.settings.appName')}</span>
                <span className="phone-settings-version">{summary}</span>
              </span>
              {state.needsAttention && (
                <span className="phone-alert-badge" aria-label={t('phone.badge.attention')}>
                  !
                </span>
              )}
              <span className="phone-chevron">
                <Icon name="phone.disclosure" size="xs" weight="medium" />
              </span>
            </button>
          </li>
        </ul>
        {groups.map((group) => (
          <div key={group.rows[0]!.label} className="phone-settings-group">
            {group.title && <h2 className="phone-settings-group-title">{t(group.title)}</h2>}
            <ul className="phone-card">
              {group.rows.map((row) => (
                <SettingsRow key={row.label} row={row} onOpen={props.onOpenPane} />
              ))}
            </ul>
          </div>
        ))}
        {version && (
          <p className="phone-library-footer phone-figures">
            {format(t('phone.settings.build'), { version })}
          </p>
        )}
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
      <header className="phone-topbar">
        <h1 className="phone-topbar-title">{t('settings.title')}</h1>
        <div className="phone-glass phone-capsule">
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('phone.settings.pair')}
            onClick={() => props.onOpenPane('sync')}
          >
            <Icon name="phone.pair" size="lg" />
          </button>
          <button
            type="button"
            className="phone-capsule-button"
            aria-label={t('settings.search')}
            onClick={() => setSearching(true)}
          >
            <Icon name="search" size="lg" />
          </button>
        </div>
      </header>
      {searching && (
        <SettingsSearch
          onOpen={(pane) => {
            setSearching(false)
            props.onOpenPane(pane)
          }}
          onClose={() => setSearching(false)}
        />
      )}
      {trialOpen && trialEnds !== null && (
        <PhoneDetailSheet
          title={t('phone.settings.trial')}
          body={format(t('phone.settings.trialEnds'), {
            date: new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(
              trialEnds,
            ),
          })}
          onClose={() => setTrialOpen(false)}
        />
      )}
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
  const [hint, setHint] = useState<SettingHint | null>(null)
  const title = PANE_TABS[pane] ? t(PANE_TABS[pane].label) : t('settings.title')
  return (
    <section aria-label={title} className="phone-screen">
      <div className="phone-scroll phone-settings-pane settings-window">
        <OnPhone.Provider value={true}>
          <ShowHint.Provider value={setHint}>{Section && <Section />}</ShowHint.Provider>
        </OnPhone.Provider>
      </div>
      <div aria-hidden="true" className="phone-topbar-band" />
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
      {hint && (
        <PhoneDetailSheet title={hint.title} body={hint.body} onClose={() => setHint(null)} />
      )}
    </section>
  )
}
