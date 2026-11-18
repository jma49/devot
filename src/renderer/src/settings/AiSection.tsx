import { Fragment, useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import {
  AI_API_PROVIDERS,
  AI_CLI_PROVIDERS,
  AI_PROVIDERS,
  isCliProvider,
  type AiApiProviderId,
  type AiCliProviderId,
  type AiCliState,
  type AiProviderId,
  type AiSettingsView,
} from '../../../core/aiProvider'
import { errorCode } from '../backups'
import { currentLocale, format, sentences, t, type MessageKey } from '../i18n'
import { licenceEntitlements, startLicence, useLicence, useTrialOver } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { lockedSentence } from '../licenceView'
import { loadAiSettings, refreshAiCli, removeAiKey, saveAiKey, saveAiSettings } from './aiProviders'
import { SUGGEST_AFTER_CHARS, SUGGEST_BEFORE_CHARS } from '../../../core/aiSuggest'
import { Select, Setting, SettingsSection, SettingToggle } from './controls'
import { failureText, logFailure } from '../failure'

const NAMES: Record<AiProviderId, MessageKey> = {
  anthropic: 'aiSettings.provider.anthropic',
  openai: 'aiSettings.provider.openai',
  claudeCli: 'aiSettings.provider.claudeCli',
  codexCli: 'aiSettings.provider.codexCli',
}

const CLI_STATES: Record<AiCliState, MessageKey> = {
  ready: 'aiSettings.cliReady',
  signedOut: 'aiSettings.cliSignedOut',
  notInstalled: 'aiSettings.cliNotInstalled',
}

const KEY_STATES = {
  set: 'aiSettings.keySet',
  unset: 'aiSettings.keyUnset',
  unknown: 'aiSettings.keyUnknown',
  unavailable: 'aiSettings.keyUnavailable',
} as const

type Drafts = Record<AiApiProviderId, { endpoint: string; model: string }> &
  Record<AiCliProviderId, { model: string }>
type Choices = Pick<AiSettingsView, 'active' | 'suggestOnIdle'>

const draftsOf = (view: AiSettingsView): Drafts => ({
  anthropic: { endpoint: view.anthropic.endpoint, model: view.anthropic.model },
  openai: { endpoint: view.openai.endpoint, model: view.openai.model },
  claudeCli: { model: view.cli?.claudeCli.model ?? '' },
  codexCli: { model: view.cli?.codexCli.model ?? '' },
})

export function AiSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const [view, setShownView] = useState<AiSettingsView>()
  const [drafts, setShownDrafts] = useState<Drafts>()
  // Saves go one after another, each built at send time from these, so a change made while an
  // earlier save was in flight is neither lost in Rust nor overwritten on screen by its answer.
  const storedView = useRef<AiSettingsView>(undefined)
  const typed = useRef<Drafts>(undefined)
  const asked = useRef<Choices>(undefined)
  const [shownChoices, setShownChoices] = useState<Choices>()
  const setAsked = (next: Choices) => {
    asked.current = next
    if (mounted.current) setShownChoices(next)
  }
  const saving = useRef<Promise<void>>(Promise.resolve())
  const mounted = useRef(true)
  const refreshingRef = useRef(false)
  const [refreshing, setRefreshing] = useState(false)
  const setView = (next: AiSettingsView) => {
    storedView.current = next
    if (mounted.current) setShownView(next)
  }
  const setDrafts = (next: (now: Drafts) => Drafts) => {
    if (!typed.current) return
    typed.current = next(typed.current)
    if (mounted.current) setShownDrafts(typed.current)
  }
  const [keys, setKeys] = useState<Record<AiApiProviderId, string>>({ anthropic: '', openai: '' })
  const [loadError, setLoadError] = useState<string>()
  const [saveError, setSaveError] = useState<{ from: 'save' | 'refresh'; code: string }>()
  // The provider whose key change was refused, so the error sits beside that key field.
  const [keyError, setKeyError] = useState<{ provider: AiApiProviderId; code: string }>()
  const [announcement, setAnnouncement] = useState('')
  const licence = useLicence()
  const trialEnded = useTrialOver()

  useEffect(() => startLicence(), [])
  useEffect(() => {
    mounted.current = true
    let live = true
    loadAiSettings().then(
      (loaded) => {
        if (!live) return
        storedView.current = loaded
        setShownView(loaded)
        typed.current = draftsOf(loaded)
        setShownDrafts(typed.current)
        asked.current = { active: loaded.active, suggestOnIdle: loaded.suggestOnIdle }
        setShownChoices(asked.current)
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

  /** Fields typed into while a change was on its way keep what was typed. */
  const settle = (sent: Drafts, stored: AiSettingsView) =>
    setDrafts((now) => ({
      anthropic: {
        endpoint:
          now.anthropic.endpoint === sent.anthropic.endpoint
            ? stored.anthropic.endpoint
            : now.anthropic.endpoint,
        model:
          now.anthropic.model === sent.anthropic.model
            ? stored.anthropic.model
            : now.anthropic.model,
      },
      openai: {
        endpoint:
          now.openai.endpoint === sent.openai.endpoint
            ? stored.openai.endpoint
            : now.openai.endpoint,
        model: now.openai.model === sent.openai.model ? stored.openai.model : now.openai.model,
      },
      claudeCli: {
        model:
          now.claudeCli.model === sent.claudeCli.model
            ? (stored.cli?.claudeCli.model ?? '')
            : now.claudeCli.model,
      },
      codexCli: {
        model:
          now.codexCli.model === sent.codexCli.model
            ? (stored.cli?.codexCli.model ?? '')
            : now.codexCli.model,
      },
    }))

  const send = async () => {
    const before = storedView.current
    const choices = asked.current
    const sent = typed.current
    if (!before || !choices || !sent) return
    const cliUnchanged =
      !before.cli || AI_CLI_PROVIDERS.every((p) => sent[p].model === before.cli?.[p].model)
    const unchanged =
      choices.active === before.active &&
      choices.suggestOnIdle === before.suggestOnIdle &&
      AI_API_PROVIDERS.every(
        (p) => sent[p].endpoint === before[p].endpoint && sent[p].model === before[p].model,
      ) &&
      cliUnchanged
    if (unchanged) return
    let kept = before
    try {
      kept = await saveAiSettings({
        ...choices,
        anthropic: sent.anthropic,
        openai: sent.openai,
        ...(before.cli ? { claudeCli: sent.claudeCli, codexCli: sent.codexCli } : {}),
      })
      setView(kept)
      if (mounted.current) setSaveError(undefined)
    } catch (e: unknown) {
      const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
      if (mounted.current) setSaveError({ from: 'save', code })
    }
    // What Rust keeps is what the pane shows again, except what was changed meanwhile.
    settle(sent, kept)
    const now = asked.current ?? choices
    setAsked({
      active: now.active === choices.active ? kept.active : now.active,
      suggestOnIdle:
        now.suggestOnIdle === choices.suggestOnIdle ? kept.suggestOnIdle : now.suggestOnIdle,
    })
  }

  const save = (choices: Partial<Choices> = {}) => {
    if (!asked.current) return
    setAsked({ ...asked.current, ...choices })
    saving.current = saving.current.then(send)
  }

  const commit = (active?: AiProviderId) => save(active ? { active } : {})

  const refreshCli = () => {
    if (refreshingRef.current || !storedView.current) return
    refreshingRef.current = true
    setRefreshing(true)
    saving.current = saving.current
      .then(send)
      .then(async () => {
        const before = storedView.current
        const choices = asked.current
        const sent = typed.current
        if (!before || !choices || !sent) return
        try {
          const refreshed = await refreshAiCli()
          setView(refreshed)
          settle(sent, refreshed)
          const now = asked.current ?? choices
          setAsked({
            active: now.active === before.active ? refreshed.active : now.active,
            suggestOnIdle:
              now.suggestOnIdle === before.suggestOnIdle
                ? refreshed.suggestOnIdle
                : now.suggestOnIdle,
          })
          if (mounted.current) {
            setSaveError((prev) => (prev?.from === 'refresh' ? undefined : prev))
            setAnnouncement(t('aiSettings.cliRefreshed'))
          }
        } catch (e: unknown) {
          const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
          if (mounted.current) {
            setAnnouncement('')
            setSaveError({ from: 'refresh', code })
          }
        }
      })
      .finally(() => {
        refreshingRef.current = false
        if (mounted.current) setRefreshing(false)
      })
  }

  const commitTyped = useEffectEvent(() => commit())
  // Back, or a tap that dismisses the app, can leave a field without blurring it.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') commitTyped()
    }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      commitTyped()
    }
  }, [])

  const setSuggestOnIdle = (suggestOnIdle: boolean) => save({ suggestOnIdle })

  const editDraft = (provider: AiApiProviderId, field: 'endpoint' | 'model', value: string) =>
    setDrafts((now) => ({ ...now, [provider]: { ...now[provider], [field]: value } }))

  const editCliModel = (provider: AiCliProviderId, model: string) =>
    setDrafts((now) => ({ ...now, [provider]: { model } }))

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit()
  }

  const changeKey = (
    provider: AiApiProviderId,
    change: () => Promise<AiSettingsView>,
    done: MessageKey,
  ) => {
    saving.current = saving.current.then(send).then(async () => {
      const before = storedView.current
      const choices = asked.current
      try {
        const next = await change()
        setView(next)
        const now = asked.current ?? choices
        if (before && now) {
          setAsked({
            active: now.active === before.active ? next.active : now.active,
            suggestOnIdle:
              now.suggestOnIdle === before.suggestOnIdle ? next.suggestOnIdle : now.suggestOnIdle,
          })
        }
        if (mounted.current) {
          setKeyError(undefined)
          setKeys((nowKeys) => ({ ...nowKeys, [provider]: '' }))
          setAnnouncement(format(t(done), { provider: t(NAMES[provider]) }))
        }
      } catch (e: unknown) {
        const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
        if (mounted.current) {
          setAnnouncement('')
          setKeyError({ provider, code })
        }
      }
    })
  }

  const errors = [
    loadError && failureText('aiSettings.loadFailed', loadError),
    saveError && failureText('aiSettings.saveFailed', saveError.code),
  ].filter(Boolean)
  // An error above a long pane may be out of sight: bring it into view when it appears.
  const errorsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (loadError || saveError) errorsRef.current?.scrollIntoView({ block: 'nearest' })
  }, [loadError, saveError])

  const providerRows = (provider: AiApiProviderId) => {
    if (!view || !drafts) return null
    const shown = view[provider]
    const name = t(NAMES[provider])
    const field = (part: string) => id(`${provider}-${part}`)
    const ownKeyError = keyError?.provider === provider ? keyError.code : undefined
    const canSave = keys[provider].trim() !== '' && shown.key !== 'unavailable'
    const canRemove = shown.key === 'set' || shown.key === 'unknown'
    return (
      <>
        <Setting
          label="aiSettings.endpoint"
          description={t('aiSettings.endpointHint')}
          htmlFor={field('endpoint')}
          descriptionId={field('endpoint-hint')}
        >
          <input
            id={field('endpoint')}
            type="text"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            value={drafts[provider].endpoint}
            placeholder={shown.defaultEndpoint}
            aria-describedby={field('endpoint-hint')}
            onChange={(e) => editDraft(provider, 'endpoint', e.currentTarget.value)}
            onBlur={() => commit()}
            onKeyDown={onEnter}
          />
        </Setting>
        <Setting
          label="aiSettings.model"
          description={t(
            shown.defaultModel ? 'aiSettings.modelHint' : 'aiSettings.modelRequiredHint',
          )}
          htmlFor={field('model')}
          descriptionId={field('model-hint')}
        >
          <input
            id={field('model')}
            type="text"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            value={drafts[provider].model}
            placeholder={shown.defaultModel}
            aria-describedby={field('model-hint')}
            onChange={(e) => editDraft(provider, 'model', e.currentTarget.value)}
            onBlur={() => commit()}
            onKeyDown={onEnter}
          />
        </Setting>
        <Setting
          label="aiSettings.key"
          description={sentences([t(KEY_STATES[shown.key]), t('aiSettings.keyHint')])}
          htmlFor={field('key')}
          descriptionId={field('key-hint')}
        >
          <input
            id={field('key')}
            type="password"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            aria-label={format(t('aiSettings.keyLabel'), { provider: name })}
            aria-describedby={
              ownKeyError ? `${field('key-hint')} ${field('key-error')}` : field('key-hint')
            }
            disabled={shown.key === 'unavailable'}
            value={keys[provider]}
            onChange={(e) => {
              const value = e.currentTarget.value
              setKeys((now) => ({ ...now, [provider]: value }))
              if (ownKeyError) setKeyError(undefined)
            }}
          />
          {/* The refused key is reported beside the field it belongs to, not only above the pane. */}
          {ownKeyError ? (
            <p id={field('key-error')} role="alert" className="settings-error">
              {failureText('aiSettings.keyFailed', ownKeyError)}
            </p>
          ) : null}
          <div className="settings-buttons">
            {/* aria-disabled, not disabled: a disabled button would drop the keyboard when it turns. */}
            <button
              type="button"
              className="button"
              aria-disabled={!canSave}
              onClick={() => {
                if (canSave) {
                  const key = keys[provider]
                  changeKey(provider, () => saveAiKey(provider, key), 'aiSettings.keySaved')
                }
              }}
            >
              {t('aiSettings.saveKey')}
            </button>
            <button
              type="button"
              className="button"
              data-destructive
              aria-disabled={!canRemove}
              onClick={() => {
                if (canRemove) {
                  changeKey(provider, () => removeAiKey(provider), 'aiSettings.keyRemoved')
                }
              }}
            >
              {t('aiSettings.removeKey')}
            </button>
          </div>
        </Setting>
      </>
    )
  }

  const availableProviders =
    view && shownChoices
      ? AI_PROVIDERS.filter(
          (p) => !isCliProvider(p) || view.cli?.[p].state === 'ready' || shownChoices.active === p,
        )
      : []

  return (
    <section className="settings-section" aria-labelledby="ai-title">
      <h2 id="ai-title" className="visually-hidden">
        {t('aiSettings.title')}
      </h2>
      <p>{t('aiSettings.detail')}</p>
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
      {licenceEntitlements.has('aiProviders') ? null : (
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
      {view && drafts && shownChoices ? (
        <>
          {view.cli ? (
            <SettingsSection title="aiSettings.localTitle" footnote={t('aiSettings.localFootnote')}>
              {AI_CLI_PROVIDERS.map((cli) => {
                const cliView = view.cli![cli]
                const name = t(NAMES[cli])
                const isActive = shownChoices.active === cli
                const isReady = cliView.state === 'ready'
                const showModel =
                  cliView.state !== 'notInstalled' || isActive || drafts[cli].model !== ''
                return (
                  <Fragment key={cli}>
                    <div className="setting client-row" role="group" aria-label={name}>
                      <div className="setting-text">
                        <span className="setting-label">{name}</span>
                        <span className="setting-description client-state">
                          <span
                            className="client-state-dot"
                            data-state={cliView.state}
                            aria-hidden="true"
                          />
                          {t(CLI_STATES[cliView.state])}
                        </span>
                      </div>
                      <div className="setting-control">
                        <div className="settings-buttons">
                          <button
                            type="button"
                            className={isActive ? 'button' : 'button button-default'}
                            aria-disabled={isActive || !isReady}
                            aria-label={format(
                              t(isActive ? 'aiSettings.cliActiveLabel' : 'aiSettings.cliUseLabel'),
                              { provider: name },
                            )}
                            onClick={() => {
                              if (!isActive && isReady) commit(cli)
                            }}
                          >
                            {t(isActive ? 'aiSettings.cliActive' : 'aiSettings.cliUse')}
                          </button>
                        </div>
                      </div>
                    </div>
                    {showModel ? (
                      <Setting
                        label="aiSettings.model"
                        description={t('aiSettings.cliModelHint')}
                        htmlFor={id(`${cli}-model`)}
                        descriptionId={id(`${cli}-model-hint`)}
                      >
                        <input
                          id={id(`${cli}-model`)}
                          type="text"
                          aria-label={format(t('aiSettings.cliModelLabel'), { provider: name })}
                          className="settings-number settings-text"
                          spellCheck={false}
                          autoComplete="off"
                          value={drafts[cli].model}
                          placeholder={t('aiSettings.cliModelDefault')}
                          aria-describedby={id(`${cli}-model-hint`)}
                          onChange={(e) => editCliModel(cli, e.currentTarget.value)}
                          onBlur={() => commit()}
                          onKeyDown={onEnter}
                        />
                      </Setting>
                    ) : null}
                  </Fragment>
                )
              })}
              <Setting
                label="aiSettings.cliRefreshTitle"
                description={t('aiSettings.cliRefreshHint')}
              >
                <button
                  type="button"
                  className="button"
                  aria-disabled={refreshing}
                  onClick={() => refreshCli()}
                >
                  {t(refreshing ? 'aiSettings.cliRefreshing' : 'aiSettings.cliRefresh')}
                </button>
              </Setting>
            </SettingsSection>
          ) : null}
          <SettingsSection title="aiSettings.activeTitle">
            <Setting
              label="aiSettings.active"
              description={t('aiSettings.activeHint')}
              htmlFor={id('active')}
              descriptionId={id('active-hint')}
            >
              <Select
                id={id('active')}
                value={shownChoices.active}
                aria-describedby={id('active-hint')}
                onChange={(e) => commit(e.currentTarget.value as AiProviderId)}
              >
                {availableProviders.map((p) => (
                  <option key={p} value={p}>
                    {t(NAMES[p])}
                  </option>
                ))}
              </Select>
            </Setting>
          </SettingsSection>
          <SettingsSection title="aiSettings.suggestTitle">
            <SettingToggle
              label="aiSettings.suggestOnIdle"
              description="aiSettings.suggestOnIdleHint"
              values={{
                before: SUGGEST_BEFORE_CHARS.toLocaleString(currentLocale()),
                after: SUGGEST_AFTER_CHARS.toLocaleString(currentLocale()),
              }}
              checked={shownChoices.suggestOnIdle}
              onChange={setSuggestOnIdle}
            />
          </SettingsSection>
          {AI_API_PROVIDERS.map((provider) => (
            <SettingsSection key={provider} title={NAMES[provider]}>
              {providerRows(provider)}
            </SettingsSection>
          ))}
        </>
      ) : null}
    </section>
  )
}
