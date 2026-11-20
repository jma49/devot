import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import {
  AI_CLI_PROVIDERS,
  isCliProvider,
  type AiApiProviderId,
  type AiCatalog,
  type AiCatalogModel,
  type AiProviderId,
  type AiSettingsView,
} from '../../../core/aiProvider'
import { SUGGEST_AFTER_CHARS, SUGGEST_BEFORE_CHARS } from '../../../core/aiSuggest'
import { errorCode } from '../backups'
import { Chevron } from '../Chevron'
import { failureText, logFailure } from '../failure'
import { formatNumber } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { licenceEntitlements, startLicence, useLicence, useTrialOver } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { lockedSentence } from '../licenceView'
import { AiKeySheet, type KeySheetSteps } from './AiKeySheet'
import {
  addRecent,
  aiProviders,
  choiceName,
  choose,
  cliChecking,
  chooseReasoning,
  isFirstRun,
  mainChoice,
  providerState,
  RECENT_LIMIT,
  rememberChoices,
  settingsChange,
  suggestChoice,
  suggestStatus,
  type Catalogs,
  type KnownModels,
  type ModelChoice,
  type PickerTarget,
  type RecentModel,
  type SuggestStatus,
} from './aiModels'
import {
  loadAiModels,
  loadAiSettings,
  refreshAiCli,
  removeAiKey,
  saveAiKey,
  saveAiSettings,
  tryAiModel,
} from './aiProviders'
import { createAiSettingsQueue } from './aiSettingsQueue'
import { Setting, SettingsSection } from './controls'
import {
  ModelPicker,
  modelLabel,
  PROVIDER_NAMES,
  ProviderMark,
  STATE_NAMES,
  StateDot,
} from './ModelPicker'
import { openNotebookPicker } from './notebookPicker'
import { aiAccessSummary, type AiAccessSummary } from './window'

const RECENT_KEY = 'devot.ai.recentModels'
const KNOWN_KEY = 'devot.ai.knownModels'

function readKnown(): KnownModels {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const known: Record<string, AiCatalogModel> = {}
    for (const [key, value] of Object.entries(parsed)) {
      const model = value as Partial<AiCatalogModel> | null
      if (
        typeof model?.id === 'string' &&
        typeof model.name === 'string' &&
        Array.isArray(model.reasoning) &&
        model.reasoning.every((level) => typeof level === 'string')
      ) {
        known[key] = {
          id: model.id,
          name: model.name,
          tier: model.tier === 'fast' || model.tier === 'best' ? model.tier : null,
          reasoning: model.reasoning,
          defaultReasoning:
            typeof model.defaultReasoning === 'string' ? model.defaultReasoning : null,
        }
      }
    }
    return known
  } catch {
    return {}
  }
}

function storeKnown(known: KnownModels) {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known))
  } catch {
    // Without storage a cloud model is named once its list is fetched.
  }
}

export function readRecent(): RecentModel[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r): r is RecentModel =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as RecentModel).provider === 'string' &&
          PROVIDER_IDS.has((r as RecentModel).provider) &&
          typeof (r as RecentModel).model === 'string',
      )
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

const PROVIDER_IDS: ReadonlySet<string> = new Set(Object.keys(PROVIDER_NAMES))

function storeRecent(recent: readonly RecentModel[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  } catch {
    // Without storage the list lasts until the window closes.
  }
}

/** Try It, for one picker's model: the answer counts only for the request and the model that asked. */
type TryState =
  | { kind: 'idle' }
  | { kind: 'trying'; request: number; target: PickerTarget; choice: ModelChoice }
  | { kind: 'tried'; target: PickerTarget; choice: ModelChoice; elapsedMs: number }
  | { kind: 'failed'; target: PickerTarget; choice: ModelChoice; code: string }

const sameChoice = (a: ModelChoice, b: ModelChoice) =>
  a.provider === b.provider && a.model === b.model && a.reasoning === b.reasoning

const SUGGEST_REASONS: Record<Extract<SuggestStatus, { kind: 'provider' }>['code'], MessageKey> = {
  E_AI_KEY_MISSING: 'aiSettings.suggest.noKey',
  E_AI_MODEL_MISSING: 'aiSettings.suggest.noModel',
  E_AI_CLI_MISSING: 'aiSettings.suggest.cliMissing',
  E_AI_AUTH_FAILED: 'aiSettings.suggest.signedOut',
}

/** The line under Suggest When I Pause: why it would not run, or that it is ready. */
export function suggestStatusText(status: SuggestStatus, modelName: string): string {
  switch (status.kind) {
    case 'off':
      return t('aiSettings.suggestHint')
    case 'licence':
      return t('aiSettings.suggest.licence')
    case 'noNotebooks':
      return t('aiSettings.suggest.noNotebooks')
    case 'checking':
      return t('aiSettings.cliChecking')
    case 'provider':
      return format(t(SUGGEST_REASONS[status.code]), {
        provider: t(PROVIDER_NAMES[status.provider]),
      })
    case 'ready':
      return format(t('aiSettings.suggest.ready'), { model: modelName })
  }
}

const sameSettings = (a: AiSettingsView, b: AiSettingsView) =>
  JSON.stringify(settingsChange(a)) === JSON.stringify(settingsChange(b))

export function AiSection() {
  const ids = useId()
  const [view, setView] = useState<AiSettingsView>()
  const [loadError, setLoadError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const [announcement, setAnnouncement] = useState('')
  const [catalogs, setCatalogs] = useState<Catalogs>({})
  const [stored] = useState<KnownModels>(readKnown)
  const known = view
    ? rememberChoices(stored, catalogs, [mainChoice(view), suggestChoice(view)])
    : stored
  const knownText = JSON.stringify(known)
  useEffect(() => storeKnown(JSON.parse(knownText) as KnownModels), [knownText])
  const [recent, setRecent] = useState<RecentModel[]>(readRecent)
  useEffect(() => storeRecent(recent), [recent])
  const [tryState, setTryState] = useState<TryState>({ kind: 'idle' })
  const [sheet, setSheet] = useState<{ provider: AiApiProviderId; firstRun: boolean }>()
  const [summary, setSummary] = useState<AiAccessSummary>()
  const [providersOpen, setProvidersOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const licence = useLicence()
  const trialEnded = useTrialOver()
  const mounted = useRef(true)
  const [queue] = useState(() =>
    createAiSettingsQueue({
      save: (next) => saveAiSettings(settingsChange(next)),
      same: sameSettings,
      onShown: setView,
      onRefused: (e) => setSaveError(logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')),
    }),
  )
  // Each provider's list is tied to the newest request for it; an older answer is dropped.
  const requests = useRef<Partial<Record<AiProviderId, number>>>({})
  const lastRequest = useRef(0)
  const tryRequest = useRef(0)

  const loadCatalogs = (providers: readonly AiProviderId[], refresh: boolean) => {
    const request = ++lastRequest.current
    for (const id of providers) requests.current[id] = request
    setCatalogs((now) => {
      const next = { ...now }
      for (const id of providers) {
        if (next[id]?.state !== 'ready') next[id] = { state: 'loading', request }
      }
      return next
    })
    const settle = (answer: (id: AiProviderId) => AiCatalog | undefined) => {
      if (!mounted.current) return
      setCatalogs((now) => {
        const next = { ...now }
        for (const id of providers) {
          const found = answer(id)
          if (requests.current[id] === request && found) next[id] = found
        }
        return next
      })
    }
    return loadAiModels(providers, refresh).then(
      (found) => {
        settle((id) => found[id])
        return found
      },
      (e: unknown) => {
        const code = logFailure(errorCode(e), 'W_AI_MODELS_FAILED')
        settle(() => ({ state: 'failed', code }))
        throw e
      },
    )
  }

  const opened = useEffectEvent((loaded: AiSettingsView) => {
    queue.loaded(loaded)
    if (cliChecking(loaded)) {
      // A change made meanwhile waits in the queue and is built on the checked answer.
      void queue.run(refreshAiCli).then(
        (checked) => {
          if (mounted.current && checked.cli)
            void loadCatalogs(AI_CLI_PROVIDERS, false).catch(() => undefined)
        },
        (e: unknown) => {
          if (mounted.current) setLoadError(logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED'))
        },
      )
      return
    }
    // The local tools list their models from this Mac; a cloud provider's list waits to be asked for.
    if (loaded.cli) void loadCatalogs(AI_CLI_PROVIDERS, false).catch(() => undefined)
  })

  useEffect(() => startLicence(), [])
  useEffect(() => {
    mounted.current = true
    let live = true
    loadAiSettings().then(
      (loaded) => {
        if (live) opened(loaded)
      },
      (e: unknown) => {
        if (live) setLoadError(logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED'))
      },
    )
    return () => {
      live = false
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let live = true
    let asked = 0
    const load = () => {
      const mine = ++asked
      aiAccessSummary().then(
        (found) => {
          if (live && mine === asked) setSummary(found)
        },
        (e: unknown) => {
          if (live) console.warn('W_AI_ACCESS_SUMMARY_FAILED', errorCode(e))
        },
      )
    }
    load()
    // Notebooks may be allowed in the main window while the pane is open.
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [])

  const errors = [
    loadError && failureText('aiSettings.loadFailed', loadError),
    saveError && failureText('aiSettings.saveFailed', saveError),
  ].filter(Boolean)
  const errorsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (loadError || saveError) errorsRef.current?.scrollIntoView({ block: 'nearest' })
  }, [loadError, saveError])

  const change = (patch: (shown: AiSettingsView) => AiSettingsView) => {
    setSaveError(undefined)
    void queue.change(patch)
  }

  const openProvider = (id: AiProviderId) => {
    if (!view || isCliProvider(id) || providerState(view, id) !== 'ready') return
    const load = catalogs[id]
    if (load === undefined || load.state === 'idle')
      void loadCatalogs([id], false).catch(() => undefined)
  }

  const pick = (target: PickerTarget, picked: { provider: AiProviderId; model: string } | null) => {
    setSaveError(undefined)
    void queue
      .change((shown) => choose(shown, target, catalogs, picked))
      .then((saved) => {
        if (saved && picked && mounted.current) setRecent((now) => addRecent(now, picked))
      })
  }

  const checkTools = () => {
    if (checking) return
    setChecking(true)
    queue
      .run(refreshAiCli)
      .then(
        (refreshed) => {
          if (!mounted.current) return
          setAnnouncement(t('aiSettings.cliRefreshed'))
          if (refreshed.cli) void loadCatalogs(AI_CLI_PROVIDERS, true).catch(() => undefined)
        },
        (e: unknown) => {
          const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
          if (mounted.current) setSaveError(code)
        },
      )
      .finally(() => {
        if (mounted.current) setChecking(false)
      })
  }

  const setUp = (id: AiProviderId, firstRun = false) => {
    if (isCliProvider(id)) checkTools()
    else setSheet({ provider: id, firstRun })
  }

  const tryIt = (target: PickerTarget) => {
    if (!view) return
    const choice = target === 'main' ? mainChoice(view) : suggestChoice(view)
    const request = ++tryRequest.current
    setTryState({ kind: 'trying', request, target, choice })
    tryAiModel(choice.provider, choice.model, choice.reasoning).then(
      (tried) => {
        if (mounted.current && tryRequest.current === request) {
          setTryState({ kind: 'tried', target, choice, elapsedMs: tried.elapsedMs })
        }
      },
      (e: unknown) => {
        const code = logFailure(errorCode(e), 'W_AI_TRY_FAILED')
        if (mounted.current && tryRequest.current === request) {
          setTryState({ kind: 'failed', target, choice, code })
        }
      },
    )
  }

  const sheetSteps = (provider: AiApiProviderId, firstRun: boolean): KeySheetSteps => ({
    saveEndpoint: async (endpoint) => {
      await queue.run(() => {
        const shown = queue.shown()
        if (!shown) return Promise.reject(new Error('E_AI_SETTINGS_INVALID'))
        return saveAiSettings(
          settingsChange({ ...shown, [provider]: { ...shown[provider], endpoint } }),
        )
      })
    },
    saveKey: async (key) => {
      await queue.run(() => saveAiKey(provider, key))
      if (firstRun) change((shown) => ({ ...shown, active: provider }))
      if (mounted.current) {
        setAnnouncement(format(t('aiSettings.keySaved'), { provider: t(PROVIDER_NAMES[provider]) }))
      }
    },
    removeKey: async () => {
      await queue.run(() => removeAiKey(provider))
      delete requests.current[provider]
      if (!mounted.current) return
      setCatalogs((now) => ({ ...now, [provider]: { state: 'idle' } }))
      setAnnouncement(format(t('aiSettings.keyRemoved'), { provider: t(PROVIDER_NAMES[provider]) }))
    },
    listModels: async () => {
      const found = await loadCatalogs([provider], true)
      const catalog = found[provider]
      if (!catalog) throw new Error('E_AI_RESPONSE_INVALID')
      return catalog
    },
  })

  const licensed = licenceEntitlements.has('aiProviders')
  const firstRun = view ? isFirstRun(view) : false

  const tryLine = (target: PickerTarget) => {
    if (!view || tryState.kind === 'idle' || tryState.target !== target) return null
    const now = target === 'main' ? mainChoice(view) : suggestChoice(view)
    if (!sameChoice(now, tryState.choice)) return null
    const text =
      tryState.kind === 'trying'
        ? format(t('aiSettings.trying'), { model: modelLabel(catalogs, known, view, target) })
        : tryState.kind === 'tried'
          ? format(t('aiSettings.tried'), {
              seconds: (tryState.elapsedMs / 1000).toLocaleString(currentLocale(), {
                maximumFractionDigits: 1,
                minimumFractionDigits: 1,
              }),
            })
          : failureText('aiSettings.tryFailed', tryState.code)
    return (
      <p
        className="ai-try-result"
        data-state={tryState.kind}
        role={tryState.kind === 'failed' ? 'alert' : 'status'}
      >
        <StateDot
          state={tryState.kind === 'tried' ? 'ok' : tryState.kind === 'failed' ? 'warn' : 'off'}
        />
        {text}
      </p>
    )
  }

  const picker = (target: PickerTarget, label: MessageKey, describedBy?: string) =>
    view ? (
      <ModelPicker
        target={target}
        label={label}
        view={view}
        catalogs={catalogs}
        recent={recent}
        known={known}
        describedBy={describedBy}
        onProvider={openProvider}
        onPick={(picked) => pick(target, picked)}
        onReasoning={(level) => change((shown) => chooseReasoning(shown, target, level))}
        onSetUp={(id) => setUp(id)}
        onRetry={(id) => void loadCatalogs([id], true).catch(() => undefined)}
        onTry={() => tryIt(target)}
      />
    ) : null

  const providerRow = (id: AiProviderId, mode: 'providers' | 'firstRun') => {
    if (!view) return null
    const state = providerState(view, id)
    const name = t(PROVIDER_NAMES[id])
    const cli = isCliProvider(id)
    const hasKey = !cli && (state === 'ready' || state === 'keyUnknown')
    const useTool = mode === 'firstRun' && cli && state === 'ready'
    return (
      <div key={id} className="setting ai-provider-row" role="group" aria-label={name}>
        <ProviderMark provider={id} state={state} />
        <div className="setting-text">
          <span className="setting-label">{name}</span>
          <span className="setting-description client-state">
            <StateDot state={state} />
            {t(STATE_NAMES[state])}
          </span>
        </div>
        <div className="setting-control">
          {useTool ? (
            <button
              type="button"
              className="button button-default"
              aria-label={format(t('aiSettings.cliUseLabel'), { provider: name })}
              onClick={() => change((shown) => ({ ...shown, active: id }))}
            >
              {t('aiSettings.cliUse')}
            </button>
          ) : cli ? (
            <button
              type="button"
              className="button"
              aria-label={format(t('aiSettings.checkAgainLabel'), { provider: name })}
              aria-disabled={checking}
              onClick={checkTools}
            >
              {t('aiSettings.checkAgain')}
            </button>
          ) : state === 'keyUnavailable' ? null : (
            <button
              type="button"
              className={mode === 'firstRun' ? 'button button-default' : 'button'}
              aria-label={format(
                t(hasKey ? 'aiSettings.changeKeyLabel' : 'aiSettings.addKeyLabel'),
                { provider: name },
              )}
              onClick={() => setUp(id, mode === 'firstRun')}
            >
              {t(hasKey ? 'aiSettings.changeKey' : 'aiSettings.addKey')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const body = () => {
    if (!view) return null
    const providers = aiProviders(view)
    if (firstRun) {
      const toolReady = AI_CLI_PROVIDERS.some((id) => view.cli?.[id].state === 'ready')
      return (
        <SettingsSection
          title="aiSettings.firstRunTitle"
          footnote={view.cli ? t('aiSettings.firstRunFootnote') : undefined}
        >
          {view.cli && !toolReady ? (
            <p className="setting ai-first-run-note">{t('aiSettings.firstRunNoTools')}</p>
          ) : null}
          {providers.map((id) => providerRow(id, 'firstRun'))}
        </SettingsSection>
      )
    }
    const main = mainChoice(view)
    const mainState = providerState(view, main.provider)
    const status = suggestStatus(view, {
      licensed,
      allowedNotebooks: summary?.allowed,
    })
    const suggestName =
      choiceName(catalogs, suggestChoice(view), known) ??
      t(PROVIDER_NAMES[suggestChoice(view).provider])
    const readyCount = providers.filter((id) => providerState(view, id) === 'ready').length
    const locale = currentLocale()
    return (
      <>
        <SettingsSection title="aiSettings.modelTitle">
          <div className="setting ai-model-row" data-setting="aiSettings.model">
            <div className="setting-text">
              <span className="setting-label" id={`${ids}-model`}>
                {t('aiSettings.model')}
              </span>
              <span id={`${ids}-model-status`} className="setting-description client-state">
                <StateDot state={mainState} />
                {format(t('aiSettings.providerStatus'), {
                  provider: t(PROVIDER_NAMES[main.provider]),
                  status: t(STATE_NAMES[mainState]),
                })}
              </span>
              {tryLine('main')}
            </div>
            <div className="setting-control">
              {picker('main', 'aiSettings.model', `${ids}-model-status`)}
            </div>
          </div>
          <Setting
            label="aiSettings.notebooks"
            description={
              summary
                ? format(t('aiSettings.notebooksCount'), {
                    allowed: formatNumber(summary.allowed, locale),
                    notebooks: formatNumber(summary.notebooks, locale),
                  })
                : ''
            }
          >
            <button type="button" className="button" onClick={openNotebookPicker}>
              {t('aiSettings.chooseNotebooks')}
            </button>
          </Setting>
        </SettingsSection>
        <SettingsSection
          title="aiSettings.suggestTitle"
          footnote={format(t('aiSettings.suggestFootnote'), {
            before: formatNumber(SUGGEST_BEFORE_CHARS, locale),
            after: formatNumber(SUGGEST_AFTER_CHARS, locale),
          })}
        >
          <div className="setting setting-toggle" data-setting="aiSettings.suggestOnIdle">
            <div className="setting-text">
              <label
                id={`${ids}-suggest-label`}
                className="setting-label"
                htmlFor={`${ids}-suggest`}
              >
                {t('aiSettings.suggestOnIdle')}
              </label>
              <span
                id={`${ids}-suggest-status`}
                className="setting-description client-state ai-suggest-status"
                data-status={status.kind}
                role="status"
              >
                {status.kind === 'off' ? null : (
                  <StateDot
                    state={
                      status.kind === 'ready' ? 'ok' : status.kind === 'checking' ? 'off' : 'warn'
                    }
                  />
                )}
                {suggestStatusText(status, suggestName)}
              </span>
            </div>
            <div className="setting-control">
              <input
                id={`${ids}-suggest`}
                type="checkbox"
                role="switch"
                checked={view.suggestOnIdle}
                aria-labelledby={`${ids}-suggest-label`}
                aria-describedby={`${ids}-suggest-status`}
                onChange={(e) => {
                  const suggestOnIdle = e.currentTarget.checked
                  change((shown) => ({ ...shown, suggestOnIdle }))
                }}
              />
            </div>
          </div>
          <div className="setting ai-model-row" data-setting="aiSettings.suggestModel">
            <div className="setting-text">
              <span className="setting-label">{t('aiSettings.suggestModel')}</span>
              <span id={`${ids}-suggest-model-hint`} className="setting-description">
                {t(
                  isCliProvider(view.active)
                    ? 'aiSettings.suggestModelLocalHint'
                    : 'aiSettings.suggestModelHint',
                )}
              </span>
              {tryLine('suggest')}
            </div>
            <div className="setting-control">
              {picker('suggest', 'aiSettings.suggestModel', `${ids}-suggest-model-hint`)}
            </div>
          </div>
        </SettingsSection>
        <section className="settings-block ai-providers" data-setting="aiSettings.providersTitle">
          <button
            type="button"
            className="hand-setup-toggle ai-providers-toggle"
            aria-expanded={providersOpen}
            aria-controls={`${ids}-providers`}
            onClick={() => setProvidersOpen((shown) => !shown)}
          >
            <Chevron open={providersOpen} closed="right" />
            <span className="settings-block-title">{t('aiSettings.providersTitle')}</span>
            <span className="settings-block-suffix">
              {format(t('aiSettings.providersSummary'), {
                ready: formatNumber(readyCount, locale),
                other: formatNumber(providers.length - readyCount, locale),
              })}
            </span>
          </button>
          {providersOpen ? (
            <div id={`${ids}-providers`} className="settings-card">
              {providers.map((id) => providerRow(id, 'providers'))}
            </div>
          ) : null}
        </section>
      </>
    )
  }

  return (
    <section className="settings-section" aria-labelledby="ai-title">
      <h2 id="ai-title" className="visually-hidden">
        {t('aiSettings.title')}
      </h2>
      <p>{t('aiSettings.lede')}</p>
      <div ref={errorsRef}>
        {errors.map((text) => (
          <p key={text} role="alert" className="settings-error">
            {text}
          </p>
        ))}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {licensed ? null : (
        <SettingsSection title="licenceSettings.title">
          <Setting
            label="licenceSettings.title"
            description={lockedSentence('ai', licence, trialEnded)}
          >
            <div className="settings-buttons">
              <LicenceButton />
            </div>
          </Setting>
        </SettingsSection>
      )}
      {body()}
      {sheet && view ? (
        <AiKeySheet
          provider={sheet.provider}
          stored={view[sheet.provider]}
          steps={sheetSteps(sheet.provider, sheet.firstRun)}
          onClose={() => setSheet(undefined)}
        />
      ) : null}
    </section>
  )
}
