import { useEffect, useId, useRef, useState } from 'react'
import { t } from '../i18n'
import { rotateICloudVault, rotateSyncVault } from '../sync'
import { Setting } from './controls'
import type { Failure } from './SyncDevices'

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
  const [asking, setAsking] = useState(false)
  const [secret, setSecret] = useState('')
  const [rotating, setRotating] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const { onRotated, failed } = props
  useEffect(() => {
    if (asking) field.current?.focus()
  }, [asking])
  const cancel = () => {
    setAsking(false)
    setSecret('')
    requestAnimationFrame(() => opener.current?.focus())
  }
  const rotate = () => {
    if (secret.trim() === '' || rotating) return
    setRotating(true)
    rotateSyncVault(secret)
      .then((rotated) => {
        setSecret('')
        setAsking(false)
        onRotated(rotated.recoveryKey)
      }, failed('syncSettings.rotateFailed'))
      .finally(() => setRotating(false))
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
            onClick={() => setAsking(true)}
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
  const [asking, setAsking] = useState(false)
  const [rotating, setRotating] = useState(false)
  const confirm = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const { onRotated, failed } = props
  useEffect(() => {
    if (asking) confirm.current?.focus()
  }, [asking])
  const cancel = () => {
    setAsking(false)
    requestAnimationFrame(() => opener.current?.focus())
  }
  const rotate = () => {
    if (rotating) return
    setRotating(true)
    rotateICloudVault()
      .then((rotated) => {
        setAsking(false)
        onRotated(rotated.recoveryKey)
      }, failed('syncSettings.rotateFailed'))
      .finally(() => setRotating(false))
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
            onClick={() => setAsking(true)}
          >
            {`${t('syncSettings.rotate')}…`}
          </button>
        )}
      </div>
    </Setting>
  )
}
