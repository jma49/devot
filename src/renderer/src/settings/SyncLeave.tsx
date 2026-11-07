import { useState } from 'react'
import { ConfirmDialog } from '../ConfirmDialog'
import { t } from '../i18n'
import { leaveSyncVault } from '../sync'
import { Setting } from './controls'
import type { Failure } from './SyncDevices'

/**
 * Leave This Vault on a relay vault: the key and the token go from this device only, so a device
 * stuck on a vault it cannot use can join one again. Nothing on the relay changes, so a dialog is
 * the confirmation.
 */
export function LeaveVaultRow(props: { onLeft: () => void; failed: Failure }) {
  const [asking, setAsking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const { onLeft, failed } = props
  const leave = () => {
    setAsking(false)
    if (leaving) return
    setLeaving(true)
    leaveSyncVault()
      .then(onLeft, failed('syncSettings.leaveFailed'))
      .finally(() => setLeaving(false))
  }
  return (
    <Setting label="syncSettings.leave" description={t('syncSettings.leaveHint')}>
      <div className="settings-buttons">
        <button
          type="button"
          className="button"
          data-destructive
          disabled={leaving}
          onClick={() => setAsking(true)}
        >
          {`${t('syncSettings.leave')}…`}
        </button>
      </div>
      {asking ? (
        <ConfirmDialog
          message={t('syncSettings.leaveConfirm')}
          detail={t('syncSettings.leaveDetail')}
          confirm={t('syncSettings.leaveButton')}
          onConfirm={leave}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </Setting>
  )
}
