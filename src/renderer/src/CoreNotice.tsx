import { t } from './i18n'
import { failureText } from './failure'

/**
 * Tells the user that the core worker, which holds the notes and saves them,
 * raised an error after it started. The window keeps running with it, so
 * this does not stop work; it says what to do if saving stops.
 */
export function CoreNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{failureText('core.failed', props.code)}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
