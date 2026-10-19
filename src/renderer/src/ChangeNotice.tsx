import { MAX_BOOK_NAME_CHARS } from '../../core/books'
import { MAX_TAG_NAME_CHARS } from '../../core/tags'
import { currentLocale, format, t } from './i18n'

const number = (n: number) => new Intl.NumberFormat(currentLocale()).format(n)

/** What a refused change says: a name's rule for a refused name, else the code. */
export function changeMessage(code: string): string {
  switch (code) {
    case 'E_TAG_NAME_TAKEN':
      return t('change.tagNameTaken')
    case 'E_TAG_NAME_INVALID':
      return format(t('change.tagNameInvalid'), { max: number(MAX_TAG_NAME_CHARS) })
    case 'E_BOOK_NAME_INVALID':
      return format(t('change.bookNameInvalid'), { max: number(MAX_BOOK_NAME_CHARS) })
    default:
      return format(t('change.failed'), { code })
  }
}

export function ChangeNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{changeMessage(props.code)}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
