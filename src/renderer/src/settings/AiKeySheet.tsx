import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { AiApiProviderId, AiCatalog, AiProviderView } from '../../../core/aiProvider'
import { errorCode } from '../backups'
import { Chevron } from '../Chevron'
import { failureText, logFailure } from '../failure'
import { countOf } from '../format'
import { currentLocale, format, t, type MessageKey } from '../i18n'
import { PROVIDER_NAMES } from './ModelPicker'

/** Where the sheet stands: one phase at a time, each step's answer checked against the sheet that asked. */
export type KeySheetPhase =
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'checking' }
  | { kind: 'checked'; models: readonly string[] }
  | { kind: 'failed'; message: MessageKey; code: string; keySaved: boolean }

export interface KeySheetSteps {
  /** Saves a changed endpoint before the key, so the key is checked against it. */
  saveEndpoint(endpoint: string): Promise<void>
  saveKey(key: string): Promise<void>
  removeKey(): Promise<void>
  /** Lists the models with the key just stored: the check that the key works. */
  listModels(): Promise<AiCatalog>
}

/** What the sheet does with a typed key, step by step; the phases it reports are what the sheet shows. */
export async function runKeySheet(
  input: { key: string; endpoint: string; storedEndpoint: string },
  steps: KeySheetSteps,
  report: (phase: KeySheetPhase) => void,
): Promise<void> {
  report({ kind: 'saving' })
  if (input.endpoint !== input.storedEndpoint) {
    try {
      await steps.saveEndpoint(input.endpoint)
    } catch (e: unknown) {
      const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
      return report({ kind: 'failed', message: 'aiSettings.endpointFailed', code, keySaved: false })
    }
  }
  if (input.key.trim() !== '') {
    try {
      await steps.saveKey(input.key)
    } catch (e: unknown) {
      const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
      return report({ kind: 'failed', message: 'aiSettings.keyFailed', code, keySaved: false })
    }
  }
  report({ kind: 'checking' })
  try {
    const catalog = await steps.listModels()
    if (catalog.state === 'failed') {
      const code = logFailure(catalog.code, 'W_AI_MODELS_FAILED')
      return report({ kind: 'failed', message: 'aiSettings.keyCheckFailed', code, keySaved: true })
    }
    report({ kind: 'checked', models: catalog.models.map((m) => m.name) })
  } catch (e: unknown) {
    const code = logFailure(errorCode(e), 'W_AI_MODELS_FAILED')
    report({ kind: 'failed', message: 'aiSettings.keyCheckFailed', code, keySaved: true })
  }
}

const SHOWN_MODELS = 6

/** Add Key or Change Key: the key is saved, then checked by listing the models it reaches. */
export function AiKeySheet(props: {
  provider: AiApiProviderId
  stored: AiProviderView
  steps: KeySheetSteps
  onClose: () => void
}) {
  const { provider, stored } = props
  const ids = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const [key, setKey] = useState('')
  const [endpoint, setEndpoint] = useState(stored.endpoint)
  const [endpointOpen, setEndpointOpen] = useState(stored.endpoint !== '')
  const [phase, setPhase] = useState<KeySheetPhase>({ kind: 'editing' })
  // Each run of the steps gets a number; a run whose sheet closed, or that a later run replaced, reports nothing.
  const run = useRef(0)
  useLayoutEffect(() => {
    const el = dialog.current
    if (el && !el.open) el.showModal()
    field.current?.focus()
    return () => {
      run.current += 1
      el?.close()
    }
  }, [])

  const name = t(PROVIDER_NAMES[provider])
  const hasKey = stored.key === 'set' || stored.key === 'unknown'
  const busy = phase.kind === 'saving' || phase.kind === 'checking'
  const done = phase.kind === 'checked'
  const canSave =
    !busy &&
    stored.key !== 'unavailable' &&
    (key.trim() !== '' || (hasKey && endpoint !== stored.endpoint))

  const save = () => {
    if (!canSave) return
    const mine = ++run.current
    void runKeySheet(
      { key, endpoint: endpoint.trim(), storedEndpoint: stored.endpoint },
      props.steps,
      (next) => {
        if (run.current !== mine) return
        setPhase(next)
        if (next.kind === 'checked' || (next.kind === 'failed' && next.keySaved)) setKey('')
      },
    )
  }

  const remove = () => {
    if (busy) return
    const mine = ++run.current
    setPhase({ kind: 'saving' })
    props.steps.removeKey().then(
      () => {
        if (run.current === mine) props.onClose()
      },
      (e: unknown) => {
        if (run.current !== mine) return
        const code = logFailure(errorCode(e), 'W_AI_SETTINGS_FAILED')
        setPhase({ kind: 'failed', message: 'aiSettings.keyFailed', code, keySaved: false })
      },
    )
  }

  const check = busy
    ? t('aiSettings.checkingKey')
    : phase.kind === 'checked'
      ? countOf(
          phase.models.length,
          currentLocale(),
          'aiSettings.keyWorksOne',
          'aiSettings.keyWorksOther',
        )
      : phase.kind === 'failed'
        ? failureText(phase.message, phase.code)
        : null

  return (
    <dialog
      ref={dialog}
      className="sheet ai-key-sheet"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-detail`}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) props.onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (done) props.onClose()
          else save()
        }}
      >
        <h2 id={`${ids}-title`} className="sheet-title">
          {format(t(hasKey ? 'aiSettings.changeKeyTitle' : 'aiSettings.addKeyTitle'), {
            provider: name,
          })}
        </h2>
        <p id={`${ids}-detail`} className="sheet-detail">
          {t('aiSettings.keySheetDetail')}
        </p>
        <label className="ai-key-field">
          <span className="setting-label">{t('aiSettings.key')}</span>
          <input
            ref={field}
            type="password"
            className="settings-number settings-text"
            spellCheck={false}
            autoComplete="off"
            aria-label={format(t('aiSettings.keyLabel'), { provider: name })}
            aria-describedby={`${ids}-check`}
            placeholder={t('aiSettings.keyPlaceholder')}
            disabled={stored.key === 'unavailable'}
            value={key}
            onChange={(e) => {
              setKey(e.currentTarget.value)
              if (phase.kind === 'failed' || phase.kind === 'checked') setPhase({ kind: 'editing' })
            }}
          />
        </label>
        <p
          id={`${ids}-check`}
          className="ai-key-check"
          data-phase={phase.kind}
          role={phase.kind === 'failed' ? 'alert' : 'status'}
        >
          {stored.key === 'unavailable' ? t('aiSettings.keyUnavailable') : check}
        </p>
        {phase.kind === 'checked' && phase.models.length > 0 ? (
          <ul className="ai-key-models" aria-label={t('aiSettings.pickerModels')}>
            {phase.models.slice(0, SHOWN_MODELS).map((model) => (
              <li key={model}>{model}</li>
            ))}
          </ul>
        ) : null}
        <div className="ai-key-endpoint">
          <button
            type="button"
            className="hand-setup-toggle"
            aria-expanded={endpointOpen}
            aria-controls={`${ids}-endpoint`}
            onClick={() => setEndpointOpen((shown) => !shown)}
          >
            <Chevron open={endpointOpen} closed="right" />
            <span>{t('aiSettings.customEndpoint')}</span>
          </button>
          {endpointOpen ? (
            <label id={`${ids}-endpoint`} className="ai-key-field">
              <span className="setting-description">{t('aiSettings.endpointHint')}</span>
              <input
                type="text"
                className="settings-number settings-text"
                spellCheck={false}
                autoComplete="off"
                aria-label={t('aiSettings.endpoint')}
                placeholder={stored.defaultEndpoint}
                value={endpoint}
                onChange={(e) => setEndpoint(e.currentTarget.value)}
              />
            </label>
          ) : null}
        </div>
        <div className="confirm-actions">
          {hasKey && !done ? (
            <button
              type="button"
              className="button ai-key-remove"
              data-destructive
              aria-disabled={busy}
              onClick={remove}
            >
              {t('aiSettings.removeKey')}
            </button>
          ) : null}
          {done ? null : (
            <button
              type="button"
              className="button"
              aria-disabled={busy}
              onClick={() => !busy && props.onClose()}
            >
              {t('dialog.cancel')}
            </button>
          )}
          <button type="submit" className="button button-default" aria-disabled={!done && !canSave}>
            {t(done ? 'aiSettings.done' : 'dialog.save')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
