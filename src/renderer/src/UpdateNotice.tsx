import { useEffect, useState, type ReactNode } from 'react'
import { t } from './i18n'
import {
  downloadUpdate,
  restartToUpdate,
  startUpdateStatus,
  updateNotice,
  useUpdateStatus,
  type UpdateStatus,
} from './updates'

const MAIN_WINDOW = 'main'

const warn = (code: string) => () => console.warn(code)

export const restartNow = () => restartToUpdate().catch(warn('W_UPDATE_RESTART_FAILED'))

/**
 * The main window's update status and its notice: an update to download
 * (auto download off) or to restart into, and the progress and outcome of a
 * check asked for from the menu or the palette. Later or Dismiss hides it
 * until there is something new to say.
 */
export function useUpdates(): { status: UpdateStatus; notice: ReactNode } {
  useEffect(() => startUpdateStatus(), [])
  const status = useUpdateStatus()
  const [dismissed, setDismissed] = useState<string>()
  const model = updateNotice(status, MAIN_WINDOW)
  if (!model || model.key === dismissed) return { status, notice: null }
  const dismiss = () => setDismissed(model.key)
  const notice = (
    <div
      role={status.state === 'failed' ? 'alert' : 'status'}
      className="notice"
      data-devot-part="notice"
      data-devot-update={status.state}
    >
      <span className="notice-text">{model.text}</span>
      {model.action === 'download' ? (
        <button
          type="button"
          className="button"
          onClick={() => void downloadUpdate().catch(warn('W_UPDATE_DOWNLOAD_FAILED'))}
        >
          {t('updates.download')}
        </button>
      ) : null}
      {model.action === 'restart' ? (
        <button type="button" className="button" onClick={() => void restartNow()}>
          {t('updates.restart')}
        </button>
      ) : null}
      <button type="button" className="button" onClick={dismiss}>
        {t(model.action ? 'updates.later' : 'notice.dismiss')}
      </button>
    </div>
  )
  return { status, notice }
}
