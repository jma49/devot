import { useEffect, useId, useRef, useState } from 'react'
import { t } from '../i18n'
import { rotateICloudVault, rotateSyncVault } from '../sync'
import { Setting } from './controls'
import type { Failure } from './SyncDevices'

/** A confirming row: closed, open for the answer, or open while its request runs, when it stays open. */
export type ConfirmStep = 'idle' | 'asking' | 'running'

/**
 * Change Vault Key on a relay vault (docs/adr/0017-sync-key-rotation.md): the relay's secret makes
 * the new vault and is never kept, so typing it is the confirmation. The new recovery key comes
 * back to show.
 */
export function RotateKeyRow(props: {
  onRotated: (recoveryKey: string | null) => void
  failed: Failure
}) {
  const ids = useId()
  const [step, setStep] = useState<ConfirmStep>('idle')
  const [secret, setSecret] = useState('')
  const asking = step !== 'idle'
  const rotating = step === 'running'
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const { onRotated, failed } = props
  useEffect(() => {
    if (asking) field.current?.focus()
  }, [asking])
  const cancel = () => {
    if (rotating) return
    setStep('idle')
    setSecret('')
    requestAnimationFrame(() => opener.current?.focus())
  }
  const rotate = () => {
    if (secret.trim() === '' || rotating) return
    setStep('running')
    rotateSyncVault(secret).then(
      (rotated) => {
        setSecret('')
        setStep('idle')
        onRotated(rotated.recoveryKey)
      },
      (e: unknown) => {
        setStep('asking')
        failed('syncSettings.rotateFailed')(e)
      },
    )
  }
  if (!asking)
    return (
      <Setting label="syncSettings.rotate" description={t('syncSettings.rotateHint')}>
        <div className="settings-buttons">
          <button
            ref={opener}
            type="button"
            className="button"
            data-destructive
            onClick={() => setStep('asking')}
          >
            {`${t('syncSettings.rotate')}…`}
          </button>
        </div>
      </Setting>
    )
  return (
    <Setting
      label="syncSettings.secret"
      description={t('syncSettings.rotateSecretHint')}
      htmlFor={`${ids}-secret`}
      descriptionId={`${ids}-hint`}
    >
      <input
        ref={field}
        id={`${ids}-secret`}
        type="password"
        className="settings-number settings-text"
        spellCheck={false}
        autoComplete="off"
        value={secret}
        aria-describedby={`${ids}-hint`}
        onChange={(e) => setSecret(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rotate()
          if (e.key === 'Escape') cancel()
        }}
      />
      <div className="settings-buttons">
        <button type="button" className="button" disabled={rotating} onClick={cancel}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button"
          data-destructive
          disabled={secret.trim() === '' || rotating}
          onClick={rotate}
        >
          {t('syncSettings.rotateButton')}
        </button>
      </div>
    </Setting>
  )
}

/**
 * Change Vault Key on iCloud (docs/adr/0017-sync-key-rotation.md, On iCloud): no secret is asked, so
 * the row first says that a lost device must be off the Apple ID, and Change Key confirms.
 */
export function ICloudRotateKeyRow(props: {
  onRotated: (recoveryKey: string | null) => void
  failed: Failure
}) {
  const [step, setStep] = useState<ConfirmStep>('idle')
  const asking = step !== 'idle'
  const rotating = step === 'running'
  const confirm = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const { onRotated, failed } = props
  useEffect(() => {
    if (asking) confirm.current?.focus()
  }, [asking])
  const cancel = () => {
    if (rotating) return
    setStep('idle')
    requestAnimationFrame(() => opener.current?.focus())
  }
  const rotate = () => {
    if (rotating) return
    setStep('running')
    rotateICloudVault().then(
      (rotated) => {
        setStep('idle')
        onRotated(rotated.recoveryKey)
      },
      (e: unknown) => {
        setStep('asking')
        failed('syncSettings.rotateFailed')(e)
      },
    )
  }
  return (
    <Setting
      label="syncSettings.rotate"
      description={t(asking ? 'syncSettings.rotateIcloudWarning' : 'syncSettings.rotateIcloudHint')}
    >
      <div className="settings-buttons">
        {asking ? (
          <>
            <button type="button" className="button" disabled={rotating} onClick={cancel}>
              {t('dialog.cancel')}
            </button>
            <button
              ref={confirm}
              type="button"
              className="button"
              data-destructive
              disabled={rotating}
              onClick={rotate}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel()
              }}
            >
              {t('syncSettings.rotateButton')}
            </button>
          </>
        ) : (
          <button
            ref={opener}
            type="button"
            className="button"
            data-destructive
            onClick={() => setStep('asking')}
          >
            {`${t('syncSettings.rotate')}…`}
          </button>
        )}
      </div>
    </Setting>
  )
}
