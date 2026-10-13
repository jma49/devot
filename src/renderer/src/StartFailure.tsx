import { format, t } from './i18n'

/**
 * Takes the whole window when the core could not start (the worker did not
 * load, or the first load of the lists failed): an empty library would look
 * like lost notes. It names the cause by code and offers Try Again.
 */
export function StartFailure(props: { code: string; onRetry: () => void }) {
  return (
    <div className="start-failure" role="alert">
      <div className="start-failure-drag" data-tauri-drag-region />
      <div className="start-failure-body">
        <h1 className="start-failure-title">{t('start.failed')}</h1>
        <p className="start-failure-detail">{format(t('start.detail'), { code: props.code })}</p>
        <button type="button" className="button" onClick={props.onRetry} autoFocus>
          {t('start.retry')}
        </button>
      </div>
    </div>
  )
}
