import { countOf } from './format'
import { currentLocale, format, t } from './i18n'

/**
 * Tells the user that pasted or dropped images could not be stored (their
 * links were not inserted), with the code of the first.
 */
export function ImageNotice(props: { codes: readonly string[]; onDismiss: () => void }) {
  const text = countOf(
    props.codes.length,
    currentLocale(),
    'images.refusedOne',
    'images.refusedOther',
  )
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{format(text, { code: props.codes[0] ?? '' })}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
