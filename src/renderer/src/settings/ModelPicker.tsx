import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { AiProviderId, AiSettingsView } from '../../../core/aiProvider'
import { closingRef } from '../closing'
import { failureText } from '../failure'
import { format, t, type MessageKey } from '../i18n'
import { Icon } from '../icons/Icon'
import { isImeKey } from '../ime'
import { fieldStep, placePickerPanel, usePickerOpen } from '../Picker'
import {
  choiceName,
  choosableRows,
  isCurrentRow,
  mainChoice,
  pickerSections,
  providerState,
  aiProviders,
  reasoningLevels,
  STATE_DOTS,
  suggestChoice,
  type Catalogs,
  type PickerRow,
  type PickerSection,
  type PickerTarget,
  type ProviderNote,
  type ProviderState,
  type KnownModels,
  type RecentModel,
  shownModel,
} from './aiModels'

export const PROVIDER_NAMES: Record<AiProviderId, MessageKey> = {
  anthropic: 'aiSettings.provider.anthropic',
  openai: 'aiSettings.provider.openai',
  claudeCli: 'aiSettings.provider.claudeCli',
  codexCli: 'aiSettings.provider.codexCli',
}

export const STATE_NAMES: Record<ProviderState, MessageKey> = {
  ready: 'aiSettings.cliReady',
  needsKey: 'aiSettings.status.needsKey',
  keyUnknown: 'aiSettings.status.keyUnknown',
  keyUnavailable: 'aiSettings.status.keyUnavailable',
  signedOut: 'aiSettings.cliSignedOut',
  notInstalled: 'aiSettings.cliNotInstalled',
}

/** Initials, not words: the mark stands beside the provider's name and is hidden from speech. */
const MONOGRAMS: Record<AiProviderId, string> = {
  codexCli: 'Cx',
  claudeCli: 'CC',
  anthropic: 'A',
  openai: 'O',
}

const LEVELS: Readonly<Record<string, MessageKey>> = {
  none: 'aiSettings.level.none',
  minimal: 'aiSettings.level.minimal',
  low: 'aiSettings.level.low',
  medium: 'aiSettings.level.medium',
  high: 'aiSettings.level.high',
  xhigh: 'aiSettings.level.xhigh',
  max: 'aiSettings.level.max',
}

/** A level a provider adds later shows by its own name. */
export const levelName = (level: string): string => {
  const key = LEVELS[level]
  return key ? t(key) : level
}

export function ProviderMark(props: { provider: AiProviderId; state?: ProviderState }) {
  return (
    <span
      className="provider-mark"
      data-provider={props.provider}
      data-state={props.state}
      aria-hidden="true"
    >
      {MONOGRAMS[props.provider]}
    </span>
  )
}

export function StateDot(props: { state: ProviderState | 'warn' | 'ok' | 'off' }) {
  const dot = props.state in STATE_DOTS ? STATE_DOTS[props.state as ProviderState] : props.state
  return <span className="ai-state-dot" data-dot={dot} aria-hidden="true" />
}

export interface ModelPickerProps {
  target: PickerTarget
  label: MessageKey
  view: AiSettingsView
  catalogs: Catalogs
  recent: readonly RecentModel[]
  known: KnownModels
  disabled?: boolean
  describedBy?: string | undefined
  /** The rail moved to a provider, or the picker opened on it: its list may be fetched now. */
  onProvider: (provider: AiProviderId) => void
  /** Null is Same as Model. */
  onPick: (picked: { provider: AiProviderId; model: string } | null) => void
  onReasoning: (level: string | null) => void
  /** A provider not set up was chosen: add its key, or check the tool again. */
  onSetUp: (provider: AiProviderId) => void
  onRetry: (provider: AiProviderId) => void
  onTry: () => void
}

const pickerClosing = closingRef('scale', 'picker-popover')

/** The model a picker's target holds, as its pop-up button and its reasoning column show it. */
function targetChoice(view: AiSettingsView, target: PickerTarget) {
  return target === 'main' ? mainChoice(view) : suggestChoice(view)
}

export function modelLabel(
  catalogs: Catalogs,
  known: KnownModels,
  view: AiSettingsView,
  target: PickerTarget,
) {
  const choice = targetChoice(view, target)
  const name = choiceName(catalogs, choice, known)
  return name ?? t('aiSettings.defaultModel')
}

export function ModelPicker(props: ModelPickerProps) {
  const { view, catalogs, target } = props
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = usePickerOpen(box)
  const choice = targetChoice(view, target)
  const following = target === 'suggest' && view.suggestModel === null
  const name = modelLabel(catalogs, props.known, view, target)
  const levels = shownModel(catalogs, props.known, choice)?.reasoning ?? []
  const sub = following
    ? t('aiSettings.sameAsModel')
    : levels.length > 0
      ? choice.reasoning === null
        ? t('aiSettings.defaultReasoning')
        : levelName(choice.reasoning)
      : undefined
  const provider = t(PROVIDER_NAMES[choice.provider])
  const show = (next: boolean) => {
    setOpen(next)
    if (next) props.onProvider(choice.provider)
  }
  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  return (
    <div ref={box} className="picker model-picker-anchor">
      <button
        ref={button}
        type="button"
        className="popup model-popup"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={props.describedBy}
        aria-disabled={props.disabled || undefined}
        aria-label={format(t('aiSettings.modelValue'), {
          label: t(props.label),
          model: sub ? `${name} · ${sub}` : name,
          provider,
        })}
        onClick={() => {
          if (!props.disabled) show(!open)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open || props.disabled) return
          e.preventDefault()
          show(true)
        }}
      >
        <ProviderMark provider={choice.provider} />
        <span className="model-popup-name">{name}</span>
        {sub ? <span className="model-popup-sub">{sub}</span> : null}
        <span className="select-chevron" aria-hidden="true">
          <Icon name="popup" size="sm" />
        </span>
      </button>
      {open ? (
        <PickerPanel
          {...props}
          close={close}
          pick={(picked) => {
            close()
            props.onPick(picked)
          }}
          setUp={(id) => {
            close()
            props.onSetUp(id)
          }}
          tryIt={() => {
            close()
            props.onTry()
          }}
        />
      ) : null}
    </div>
  )
}

function PickerPanel(
  props: ModelPickerProps & {
    close: () => void
    pick: (picked: { provider: AiProviderId; model: string } | null) => void
    setUp: (provider: AiProviderId) => void
    tryIt: () => void
  },
) {
  const { view, catalogs, target } = props
  const ids = useId()
  const choice = targetChoice(view, target)
  const [rail, setRail] = useState<AiProviderId>(choice.provider)
  const [query, setQuery] = useState('')
  const [typing, setTyping] = useState<AiProviderId>()
  const [typed, setTyped] = useState('')
  const [active, setActive] = useState(0)
  const panel = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const ref = useCallback((el: HTMLDivElement | null) => {
    pickerClosing(el)
    panel.current = el
  }, [])
  useLayoutEffect(() => {
    if (panel.current) placePickerPanel(panel.current)
  }, [])
  // The search field mounts again when Other Model ID closes, so focus follows it there too.
  useLayoutEffect(() => {
    if (!typing) search.current?.focus()
  }, [typing])

  const sections = pickerSections({ view, target, catalogs, recent: props.recent, rail, query })
  const rows = choosableRows(sections)
  const note = sections.find((s) => s.note)?.note
  const shownActive = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)
  const optionId = (i: number) => `${ids}-option-${i}`
  const ready = (id: AiProviderId) => providerState(view, id) === 'ready'

  const choose = (row: PickerRow) => {
    if (row.kind === 'same') return props.pick(null)
    if (!ready(row.provider)) return props.setUp(row.provider)
    if (row.kind === 'other') {
      setTyping(row.provider)
      setTyped(query.trim())
      return
    }
    props.pick({ provider: row.provider, model: row.model })
  }

  const moveRail = (id: AiProviderId) => {
    setRail(id)
    setQuery('')
    setTyping(undefined)
    setActive(0)
    props.onProvider(id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (typing) {
        setTyping(undefined)
        return
      }
      return props.close()
    }
    if (e.metaKey && /^[1-3]$/.test(e.key)) {
      const recent = rows.find((r) => r.kind === 'model' && r.recent === Number(e.key) - 1)
      if (recent) {
        e.preventDefault()
        choose(recent)
      }
    }
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[shownActive]
      if (row) choose(row)
      return
    }
    const next = fieldStep(e.key, shownActive, rows.length)
    if (next === undefined) return
    e.preventDefault()
    setActive(next)
  }

  const railState = providerState(view, rail)
  const { levels, fallback } = reasoningLevels(catalogs, choice)
  const following = target === 'suggest' && view.suggestModel === null
  const showReasoning = levels.length > 0
  const firstRow = sections.map((_, s) =>
    sections.slice(0, s).reduce((sum, section) => sum + section.rows.length, 0),
  )
  return (
    <div
      ref={ref}
      className="picker-popover model-picker"
      role="dialog"
      aria-label={t('aiSettings.picker')}
      onKeyDown={onKeyDown}
    >
      <div className="model-picker-body">
        <div
          className="model-picker-rail"
          role="group"
          aria-label={t('aiSettings.pickerProviders')}
        >
          {aiProviders(view).map((id) => {
            const state = providerState(view, id)
            return (
              <button
                key={id}
                type="button"
                className="model-picker-rail-button"
                aria-pressed={id === rail}
                aria-label={format(t('aiSettings.providerStatus'), {
                  provider: t(PROVIDER_NAMES[id]),
                  status: t(STATE_NAMES[state]),
                })}
                title={t(PROVIDER_NAMES[id])}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => moveRail(id)}
              >
                <ProviderMark provider={id} state={state} />
                <StateDot state={state} />
              </button>
            )
          })}
        </div>
        <div className="model-picker-list">
          {typing ? (
            <OtherModelField
              provider={typing}
              value={typed}
              onChange={setTyped}
              onDone={() => {
                const id = typed.trim()
                if (id !== '') props.pick({ provider: typing, model: id })
              }}
            />
          ) : (
            <div className="picker-search-field">
              <span className="picker-search-icon">
                <Icon name="search" size="sm" />
              </span>
              <input
                ref={search}
                type="search"
                className="picker-search"
                role="combobox"
                aria-label={t('aiSettings.pickerSearch')}
                aria-expanded="true"
                aria-controls={`${ids}-list`}
                aria-autocomplete="list"
                aria-activedescendant={shownActive >= 0 ? optionId(shownActive) : undefined}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={t('aiSettings.pickerSearch')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={onSearchKey}
              />
            </div>
          )}
          <div className="model-picker-scroll">
            <ul
              id={`${ids}-list`}
              className="picker-list model-picker-options"
              role="listbox"
              aria-label={t('aiSettings.pickerModels')}
            >
              {sections.map((section, s) => (
                <SectionRows
                  key={s}
                  section={section}
                  render={(row, r) => {
                    const i = firstRow[s]! + r
                    return (
                      <li
                        key={i}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === shownActive}
                        data-current={isCurrentRow(view, target, row) || undefined}
                        className="picker-option model-picker-option"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(row)}
                      >
                        <RowContent
                          row={row}
                          current={isCurrentRow(view, target, row)}
                          catalogs={catalogs}
                          marked={section.title?.kind !== 'provider' || query.trim() !== ''}
                        />
                      </li>
                    )
                  }}
                />
              ))}
            </ul>
            {note ? (
              <Note
                note={note}
                provider={rail}
                onSetUp={() => props.setUp(rail)}
                onRetry={() => props.onRetry(rail)}
              />
            ) : null}
          </div>
        </div>
        {showReasoning ? (
          <div className="model-picker-reasoning" role="group" aria-labelledby={`${ids}-reasoning`}>
            <h3 id={`${ids}-reasoning`} className="model-picker-caption">
              {t('aiSettings.reasoning')}
            </h3>
            {[null, ...levels].map((level) => {
              const on = !following && choice.reasoning === level
              return (
                <button
                  key={level ?? ''}
                  type="button"
                  className="model-picker-level"
                  aria-pressed={on}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => props.onReasoning(level)}
                >
                  <span className="picker-name">
                    {level === null
                      ? fallback === null
                        ? t('aiSettings.defaultReasoning')
                        : format(t('aiSettings.defaultReasoningNamed'), {
                            level: levelName(fallback),
                          })
                      : levelName(level)}
                  </span>
                  <span className="model-picker-check" aria-hidden="true">
                    {on ? <Icon name="check" size="sm" /> : null}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="model-picker-foot">
        <span className="model-picker-status">
          <StateDot state={railState} />
          {format(t('aiSettings.providerStatus'), {
            provider: t(PROVIDER_NAMES[rail]),
            status: t(STATE_NAMES[railState]),
          })}
        </span>
        {ready(choice.provider) ? (
          <button
            type="button"
            className="model-picker-try"
            onMouseDown={(e) => e.preventDefault()}
            onClick={props.tryIt}
          >
            {t('aiSettings.tryIt')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function SectionRows(props: {
  section: PickerSection
  render: (row: PickerRow, index: number) => ReactNode
}) {
  const { title } = props.section
  const heading =
    title === null
      ? null
      : title.kind === 'recent'
        ? t('aiSettings.recent')
        : title.ready
          ? t(PROVIDER_NAMES[title.provider])
          : format(t('aiSettings.notSetUpGroup'), { provider: t(PROVIDER_NAMES[title.provider]) })
  return (
    <>
      {heading ? (
        <li className="model-picker-group" role="presentation">
          {heading}
        </li>
      ) : null}
      {props.section.rows.map(props.render)}
    </>
  )
}

function RowContent(props: {
  row: PickerRow
  current: boolean
  catalogs: Catalogs
  marked: boolean
}) {
  const { row } = props
  const check = (
    <span className="model-picker-check" aria-hidden="true">
      {props.current ? <Icon name="check" size="sm" /> : null}
    </span>
  )
  if (row.kind === 'same') {
    return (
      <>
        {check}
        <span className="picker-name">{t('aiSettings.sameAsModel')}</span>
      </>
    )
  }
  if (row.kind === 'other') {
    return (
      <>
        {check}
        <span className="picker-name model-picker-other">{t('aiSettings.otherModel')}</span>
      </>
    )
  }
  const name =
    row.name ??
    (() => {
      const named = choiceName(props.catalogs, {
        provider: row.provider,
        model: '',
        reasoning: null,
      })
      return named === null
        ? t('aiSettings.defaultModel')
        : format(t('aiSettings.defaultModelNamed'), { model: named })
    })()
  return (
    <>
      {check}
      {props.marked ? <ProviderMark provider={row.provider} /> : null}
      <span className="picker-name">{name}</span>
      {row.tier ? (
        <span className="model-tier" data-tier={row.tier}>
          {t(row.tier === 'fast' ? 'aiSettings.tier.fast' : 'aiSettings.tier.best')}
        </span>
      ) : null}
      {row.recent === undefined ? null : <kbd className="picker-key">{`⌘${row.recent + 1}`}</kbd>}
    </>
  )
}

function Note(props: {
  note: ProviderNote
  provider: AiProviderId
  onSetUp: () => void
  onRetry: () => void
}) {
  const { note } = props
  const name = t(PROVIDER_NAMES[props.provider])
  if (note.kind === 'loading') {
    return <p className="model-picker-note">{t('aiSettings.modelsLoading')}</p>
  }
  if (note.kind === 'failed') {
    return (
      <div className="model-picker-note">
        <p>{failureText('aiSettings.modelsFailed', note.code)}</p>
        <button type="button" className="button" onClick={props.onRetry}>
          {t('aiSettings.tryAgain')}
        </button>
      </div>
    )
  }
  const cli = note.state === 'signedOut' || note.state === 'notInstalled'
  const hint: MessageKey =
    note.state === 'signedOut'
      ? 'aiSettings.blocked.signedOut'
      : note.state === 'notInstalled'
        ? 'aiSettings.blocked.notInstalled'
        : note.state === 'keyUnavailable'
          ? 'aiSettings.keyUnavailable'
          : 'aiSettings.blocked.key'
  return (
    <div className="model-picker-note">
      <p className="model-picker-note-title">
        {format(t('aiSettings.blocked.title'), { provider: name })}
      </p>
      <p>{t(hint)}</p>
      {note.state === 'keyUnavailable' ? null : (
        <button type="button" className="button button-default" onClick={props.onSetUp}>
          {t(
            cli
              ? 'aiSettings.checkAgain'
              : note.state === 'keyUnknown'
                ? 'aiSettings.changeKey'
                : 'aiSettings.addKey',
          )}
        </button>
      )}
    </div>
  )
}

function OtherModelField(props: {
  provider: AiProviderId
  value: string
  onChange: (value: string) => void
  onDone: () => void
}) {
  const field = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => field.current?.focus(), [])
  return (
    <div className="picker-search-field">
      <input
        ref={field}
        type="text"
        className="picker-search model-picker-id"
        aria-label={format(t('aiSettings.otherModelField'), {
          provider: t(PROVIDER_NAMES[props.provider]),
        })}
        placeholder={format(t('aiSettings.otherModelField'), {
          provider: t(PROVIDER_NAMES[props.provider]),
        })}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent) || e.key !== 'Enter') return
          e.preventDefault()
          props.onDone()
        }}
      />
    </div>
  )
}
