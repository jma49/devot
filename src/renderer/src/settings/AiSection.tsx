import { useEffect, useId, useRef, useState } from 'react'
import {
  AI_PROVIDERS,
  type AiProviderId,
  type AiSettingsChange,
  type AiSettingsView,
} from '../../../core/aiProvider'
import { errorCode } from '../backups'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { licenceEntitlements, startLicence, useLicence, useTrialOver } from '../licence'
import { LicenceButton } from '../LicenceLocked'
import { loadAiSettings, removeAiKey, saveAiKey, saveAiSettings } from './aiProviders'
import { SUGGEST_AFTER_CHARS, SUGGEST_BEFORE_CHARS } from '../../../core/aiSuggest'
import { Select, Setting, SettingsSection, SettingToggle } from './controls'

const NAMES: Record<AiProviderId, MessageKey> = {
  anthropic: 'aiSettings.provider.anthropic',
  openai: 'aiSettings.provider.openai',
}

const KEY_STATES = {
  set: 'aiSettings.keySet',
  unset: 'aiSettings.keyUnset',
  unknown: 'aiSettings.keyUnknown',
  unavailable: 'aiSettings.keyUnavailable',
} as const

type Drafts = Record<AiProviderId, { endpoint: string; model: string }>

const draftsOf = (view: AiSettingsView): Drafts => ({
  anthropic: { endpoint: view.anthropic.endpoint, model: view.anthropic.model },
  openai: { endpoint: view.openai.endpoint, model: view.openai.model },
})

export function AiSection() {
  const ids = useId()
  const id = (name: string) => `${ids}-${name}`
  const [view, setView] = useState<AiSettingsView>()
  const [drafts, setDrafts] = useState<Drafts>()
  const [keys, setKeys] = useState<Record<AiProviderId, string>>({ anthropic: '', openai: '' })
  const [loadError, setLoadError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  // The provider whose key change was refused, so the error sits beside that key field.
  const [keyError, setKeyError] = useState<{ provider: AiProviderId; code: string }>()
  const [announcement, setAnnouncement] = useState('')
  // Re-renders when the licence changes, which licenceEntitlements reads.
  useLicence()
  const trialEnded = useTrialOver()

  useEffect(() => startLicence(), [])
  useEffect(() => {
    let live = true
    loadAiSettings().then(
      (loaded) => {
        if (!live) return
        setView(loaded)
        setDrafts(draftsOf(loaded))
      },
      (e: unknown) => {
        if (live) setLoadError(errorCode(e))
      },
    )
    return () => {
      live = false
    }
  }, [])

  /** Fields typed into while a change was on its way keep what was typed. */
  const settle = (sent: Drafts, stored: AiSettingsView) =>
    setDrafts(
      (now) =>
        now &&
        (Object.fromEntries(
          AI_PROVIDERS.map((p) => [
            p,
            {
              endpoint: now[p].endpoint === sent[p].endpoint ? stored[p].endpoint : now[p].endpoint,
              model: now[p].model === sent[p].model ? stored[p].model : now[p].model,
            },
          ]),
        ) as Drafts),
    )

  const save = (change: AiSettingsChange) =>
    saveAiSettings(change).then(
      (next) => {
        setView(next)
        settle(change, next)
        setSaveError(undefined)
      },
      (e: unknown) => {
        setSaveError(errorCode(e))
        // What Rust keeps is what the fields show again.
        if (view) settle(change, view)
      },
    )

  const commit = (active: AiProviderId = view?.active ?? 'anthropic') => {
    if (!view || !drafts) return
    const unchanged =
      active === view.active &&
      AI_PROVIDERS.every(
        (p) => drafts[p].endpoint === view[p].endpoint && drafts[p].model === view[p].model,
      )
    if (!unchanged) {
      void save({
        active,
        suggestOnIdle: view.suggestOnIdle,
        anthropic: drafts.anthropic,
        openai: drafts.openai,
      })
    }
  }

  const setSuggestOnIdle = (suggestOnIdle: boolean) => {
    if (!view || !drafts) return
    void save({ active: view.active, suggestOnIdle, ...drafts })
  }

  const editDraft = (provider: AiProviderId, field: 'endpoint' | 'model', value: string) =>
    setDrafts((now) => now && { ...now, [provider]: { ...now[provider], [field]: value } })

  const changeKey = (provider: AiProviderId, change: Promise<AiSettingsView>, done: MessageKey) =>
    change.then(
      (next) => {
        setView(next)
        setKeyError(undefined)
        setKeys((now) => ({ ...now, [provider]: '' }))
        setAnnouncement(format(t(done), { provider: t(NAMES[provider]) }))
      },
      (e: unknown) => {
        setAnnouncement('')
        setKeyError({ provider, code: errorCode(e) })
      },
    )

  const errors = [
    loadError && format(t('aiSettings.loadFailed'), { code: loadError }),
    saveError && format(t('aiSettings.saveFailed'), { code: saveError }),
  ].filter(Boolean)
  // An error above a long pane may be out of sight: bring it into view when it appears.
  const errorsRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (loadError || saveError) errorsRef.current?.scrollIntoView({ block: 'nearest' })
  }, [loadError, saveError])

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
            description={t(trialEnded ? 'licence.locked.aiTrialEnded' : 'licence.locked.ai')}
          >
            <div className="settings-buttons">
              <LicenceButton />
            </div>
          </Setting>
        </SettingsSection>
      )}
      {view && drafts ? (
        <>
          <SettingsSection title="aiSettings.activeTitle">
            <Setting
              label="aiSettings.active"
              description={t('aiSettings.activeHint')}
              htmlFor={id('active')}
              descriptionId={id('active-hint')}
            >
              <Select
                id={id('active')}
                value={view.active}
                aria-describedby={id('active-hint')}
                onChange={(e) => commit(e.currentTarget.value as AiProviderId)}
              >
                {AI_PROVIDERS.map((p) => (
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
              checked={view.suggestOnIdle}
              onChange={setSuggestOnIdle}
            />
          </SettingsSection>
          {AI_PROVIDERS.map((provider) => {
            const shown = view[provider]
            const name = t(NAMES[provider])
            const field = (part: string) => id(`${provider}-${part}`)
            const ownKeyError = keyError?.provider === provider ? keyError.code : undefined
            const canSave = keys[provider].trim() !== '' && shown.key !== 'unavailable'
            const canRemove = shown.key === 'set' || shown.key === 'unknown'
            const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') commit()
            }
            return (
              <SettingsSection key={provider} title={NAMES[provider]}>
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
                  description={`${t(KEY_STATES[shown.key])} ${t('aiSettings.keyHint')}`}
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
                      {format(t('aiSettings.keyFailed'), { code: ownKeyError })}
                    </p>
                  ) : null}
                  <div className="settings-buttons">
                    {/* aria-disabled, not disabled: a disabled button would drop the keyboard when it turns. */}
                    <button
                      type="button"
                      className="button"
                      aria-disabled={!canSave}
                      onClick={() => {
                        if (canSave)
                          void changeKey(
                            provider,
                            saveAiKey(provider, keys[provider]),
                            'aiSettings.keySaved',
                          )
                      }}
                    >
                      {t('aiSettings.saveKey')}
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-disabled={!canRemove}
                      onClick={() => {
                        if (canRemove)
                          void changeKey(provider, removeAiKey(provider), 'aiSettings.keyRemoved')
                      }}
                    >
                      {t('aiSettings.removeKey')}
                    </button>
                  </div>
                </Setting>
              </SettingsSection>
            )
          })}
        </>
      ) : null}
    </section>
  )
}
