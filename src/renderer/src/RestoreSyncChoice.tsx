import { useState } from 'react'
import { RESTORE_CHOICE } from '../../core/sync/restore'
import { ConfirmDialog } from './ConfirmDialog'
import { t } from './i18n'
import type { SyncSnapshot } from './sync'

/**
 * Sync turned on after a backup was restored here (ADR 0013): the engine waits until the person
 * chooses. Merge, the default, keeps Return and Escape; Keep This Mac's Copy makes the restored
 * notes win on every device.
 */
export function RestoreSyncChoice(props: {
  snapshot: SyncSnapshot
  onChoose: (choice: 'merge' | 'keep') => Promise<unknown>
}) {
  const [chosen, setChosen] = useState(false)
  const { state, code } = props.snapshot.status
  const waiting = props.snapshot.enabled && state === 'stopped' && code === RESTORE_CHOICE
  if (!waiting) {
    if (chosen) setChosen(false)
    return null
  }
  if (chosen) return null
  const choose = (choice: 'merge' | 'keep') => {
    setChosen(true)
    void props.onChoose(choice).catch(() => {
      console.warn('W_SYNC_RESTORE_CHOICE_FAILED')
      setChosen(false)
    })
  }
  return (
    <ConfirmDialog
      message={t('sync.restore.message')}
      detail={t('sync.restore.detail')}
      cancel={t('sync.restore.merge')}
      confirm={t('sync.restore.keep')}
      onCancel={() => choose('merge')}
      onConfirm={() => choose('keep')}
    />
  )
}
