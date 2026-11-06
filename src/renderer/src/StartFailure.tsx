import { t } from './i18n'

/**
 * Takes the whole window when the core could not start (the worker did not
 * load, or the first load of the lists failed): an empty library would look
 * like lost notes. It offers Try Again; the cause's code goes to the log, and
 * from there into Export Diagnostics.
 */
export function StartFailure(props: { onRetry: () => void }) {
  return (
    <div className="start-failure" role="alert">
      <div className="start-failure-drag" data-tauri-drag-region />
      <div className="start-failure-body">
        <h1 className="start-failure-title">{t('start.failed')}</h1>
        <p className="start-failure-detail">{t('start.detail')}</p>
        <button type="button" className="button" onClick={props.onRetry} autoFocus>
          {t('start.retry')}
        </button>
      </div>
    </div>
  )
}
