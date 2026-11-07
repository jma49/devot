import { useEffect, useRef, useState, type ReactNode } from 'react'
import { errorCode } from '../../../core/errors'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import {
  editingAllowed,
  requestRefund,
  restorePurchases,
  soldOnAppStore,
  trialRunning,
  useLicence,
} from '../licence'
import { licenceProblem } from '../licenceView'
import { OnPhone } from '../settings/onPhone'
import type { IconName } from '../icons/symbols'
import { PANES, PANE_TABS, type PaneId } from '../settings/panes'
import { searchSettings } from '../settings/search'
import { startSyncStatus, useSyncSnapshot } from '../sync'
import { syncNeedsOwner } from '../syncICloud'
import { doveMask } from './dove'
import { MacKeyRow } from './PhoneMacKey'
import { PhoneDetailSheet } from './PhoneSheet'
import { useLicenceClock } from './licenceClock'
import { licenceRow } from './settingsRows'
import { logFailure } from '../failure'
import { revealAnchor } from './paneAnchor'
import type { PaneAnchor } from './screens/settings'

/** The panes that open on a phone; the rest are left out of its Settings. The phone records no usage. */
type PhonePane = Exclude<PaneId, 'keyboard' | 'mirror' | 'integrations' | 'plugins' | 'usage'>

interface Row {
  readonly pane: PhonePane
  readonly label: MessageKey
  readonly icon: IconName
  readonly value?: string
  readonly alert?: boolean
}

const PANE_ICONS: Readonly<Record<PhonePane, IconName>> = {
  general: 'phone.settings.general',
  appearance: 'phone.settings.appearance',
  editing: 'phone.settings.editing',
  preview: 'phone.settings.preview',
  sync: 'phone.settings.sync',
  ai: 'phone.settings.ai',
  licence: 'phone.settings.licence',
}

const paneRow = (pane: PhonePane, value?: string, alert?: boolean): Row => ({
  pane,
  label: PANE_TABS[pane].label,
  icon: PANE_ICONS[pane],
  ...(value === undefined ? {} : { value }),
  ...(alert === undefined ? {} : { alert }),
})

const OPEN_PANES = PANES.filter((pane): pane is PhonePane => pane in PANE_ICONS)
const GENERAL_GROUP: readonly PhonePane[] = ['general', 'appearance', 'editing', 'preview']

function SettingsRow(props: { row: Row; onOpen: (pane: PaneId) => void }) {
  const { row } = props
  return (
    <li className="phone-grouped-row">
      <button type="button" className="phone-grouped-open" onClick={() => props.onOpen(row.pane)}>
        <span className="phone-row-icon">
          <Icon name={row.icon} size="phone-row" />
        </span>
        <span className="phone-grouped-text">
          <span className="phone-grouped-label">{t(row.label)}</span>
          {row.value && <span className="phone-grouped-count">{row.value}</span>}
        </span>
        {row.alert && (
          <span className="phone-alert-badge" aria-label={t('phone.badge.attention')}>
            !
          </span>
        )}
        <span className="phone-chevron">
          <Icon name="phone.disclosure" size="xs" weight="medium" />
        </span>
      </button>
    </li>
  )
}

type Restoring = 'running' | 'restored' | 'nothing' | { readonly code: string }

function restoreValue(state: Restoring | null): string | undefined {
  if (state === null) return undefined
  if (state === 'running') return t('phone.settings.restoring')
  if (state === 'restored') return t('phone.settings.restored')
  if (state === 'nothing') return t('phone.settings.nothingRestored')
  return licenceProblem(state.code)
}

/** An App Store action: it has no chevron, and its outcome is its value. */
function ActionRow(props: {
  label: MessageKey
  value: string | undefined
  busy: boolean
  onClick: () => void
}) {
  return (
    <li className="phone-grouped-row">
      <button
        type="button"
        className="phone-grouped-open phone-settings-action"
        aria-disabled={props.busy}
        onClick={props.onClick}
      >
        <span className="phone-grouped-text">
          <span className="phone-grouped-label">{t(props.label)}</span>
          <span className="phone-grouped-count" role="status">
            {props.value}
          </span>
        </span>
      </button>
    </li>
  )
}

function RestoreRow() {
  const [state, setState] = useState<Restoring | null>(null)
  const restore = () => {
    if (state === 'running') return
    setState('running')
    restorePurchases().then(
      () => setState(editingAllowed() ? 'restored' : 'nothing'),
      (error: unknown) =>
        setState({ code: logFailure(errorCode(error), 'W_PHONE_RESTORE_FAILED') }),
    )
  }
  return (
    <ActionRow
      label="phone.settings.restore"
      value={restoreValue(state)}
      busy={state === 'running'}
      onClick={restore}
    />
  )
}

type Refunding = 'running' | 'requested' | { readonly problem: MessageKey }

const REFUND_PROBLEMS: Readonly<Record<string, MessageKey>> = {
  E_APP_STORE_REFUND_DUPLICATE: 'phone.settings.refundDuplicate',
  E_APP_STORE_NETWORK: 'phone.settings.refundOffline',
}

function refundValue(state: Refunding | null): string | undefined {
  if (state === null) return undefined
  if (state === 'running') return t('phone.settings.refundOpening')
  if (state === 'requested') return t('phone.settings.refundRequested')
  return t(state.problem)
}

/** Request a Refund, while Devot Pro is held through the App Store: a cancel leaves the row as it was. */
function RefundRow() {
  const [state, setState] = useState<Refunding | null>(null)
  const request = () => {
    if (state === 'running') return
    setState('running')
    requestRefund().then(
      (outcome) => setState(outcome === 'requested' ? 'requested' : null),
      (error: unknown) =>
        setState({ problem: REFUND_PROBLEMS[errorCode(error)] ?? 'phone.settings.refundFailed' }),
    )
  }
  return (
    <ActionRow
      label="phone.settings.refund"
      value={refundValue(state)}
      busy={state === 'running'}
      onClick={request}
    />
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

function SettingsSearch(props: {
  panes: readonly PhonePane[]
  onOpen: (pane: PaneId) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const rows: Row[] =
    query.trim() === ''
      ? props.panes.map((pane) => paneRow(pane))
      : searchSettings(query, t, { onPhone: true, panes: props.panes }).map((result) => ({
          ...paneRow(result.pane as PhonePane),
          label: result.label,
          ...(result.paneLabel ? { value: t(result.paneLabel) } : {}),
        }))
  return (
    <div className="phone-settings-search">
      <div className="phone-scroll phone-settings">
        {rows.length > 0 ? (
          <ul className="phone-card">
            {rows.map((row) => (
              <SettingsRow key={`${row.pane}:${row.label}`} row={row} onOpen={props.onOpen} />
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
  const now = useLicenceClock(licence)
  const [searching, setSearching] = useState(false)
  const [trialOpen, setTrialOpen] = useState(false)
  useEffect(() => startSyncStatus(), [])
  const state = licenceRow(licence, now)
  const trialEnds = licence.trial?.endsAt ?? null
  const store = soldOnAppStore(licence)
  const groups: readonly { title?: MessageKey; rows: readonly Row[]; after?: ReactNode }[] = [
    {
      title: 'phone.settings.group.general',
      rows: GENERAL_GROUP.map((pane) => paneRow(pane)),
    },
    {
      title: 'phone.settings.group.sync',
      rows: [
        paneRow(
          'sync',
          t(sync.enabled ? 'phone.settings.on' : 'phone.settings.off'),
          syncNeedsOwner(sync),
        ),
      ],
    },
    {
      title: 'phone.settings.group.ai',
      rows: [paneRow('ai')],
    },
    {
      rows: [paneRow('licence', state.label, state.needsAttention)],
      ...(store
        ? {
            after: (
              <>
                <RestoreRow />
                {licence.appStore?.pro && (
                  <>
                    <MacKeyRow />
                    <RefundRow />
                  </>
                )}
              </>
            ),
          }
        : {}),
    },
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
              {group.after}
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
          panes={OPEN_PANES}
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
          body={format(t(store ? 'phone.settings.trialEndsStore' : 'phone.settings.trialEnds'), {
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
  sync: () => import('../settings/SyncSection').then((m) => m.SyncSection),
  ai: () => import('../settings/AiSection').then((m) => m.AiSection),
  licence: () => import('../settings/LicenceSection').then((m) => m.LicenceSection),
}

/**
 * An existing Settings pane, in a phone screen of its own; under the native navigation bar
 * (`nativeBar`) it draws no top bar of its own.
 */
export function PhoneSettingsPane(props: {
  pane: string
  focusKey?: boolean
  anchor?: PaneAnchor | undefined
  nativeBar?: boolean
  onBack: () => void
}) {
  const pane = props.pane as PaneId
  const [Section, setSection] = useState<(() => React.JSX.Element) | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (Section && props.focusKey)
      scroller.current
        ?.querySelector<HTMLInputElement>('input[data-licence-key]')
        ?.focus({ preventScroll: true })
  }, [Section, props.focusKey])
  useEffect(() => {
    if (Section && props.anchor && scroller.current)
      return revealAnchor(scroller.current, props.anchor)
  }, [Section, props.anchor])
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
    <section aria-label={title} className="phone-screen">
      <div
        ref={scroller}
        className="phone-scroll phone-settings-pane settings-window"
        data-native-bar={props.nativeBar ? '' : undefined}
      >
        <OnPhone.Provider value={true}>{Section && <Section />}</OnPhone.Provider>
      </div>
      {props.nativeBar ? null : (
        <>
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
        </>
      )}
    </section>
  )
}
