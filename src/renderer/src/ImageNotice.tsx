import { MAX_FILE_BYTES } from '../../core/files'
import { dismissImageActionFailure, useImageActionFailure } from './imageMenu'
import { countOf } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'

const REASONS: Readonly<Record<string, MessageKey>> = {
  E_FILE_SIZE_INVALID: 'images.reason.size',
  E_FILE_TYPE_REFUSED: 'images.reason.type',
  E_FILE_NAME_INVALID: 'images.reason.name',
}

/** Why the first of `codes` was refused, with its code. */
export function refusedImagesText(codes: readonly string[]): string {
  const locale = currentLocale()
  const code = codes[0] ?? ''
  const reason = format(t(REASONS[code] ?? 'images.reason.other'), {
    size: (MAX_FILE_BYTES / (1024 * 1024)).toLocaleString(locale),
  })
  const text = countOf(codes.length, locale, 'images.refusedOne', 'images.refusedOther')
  return format(text, { reason, code })
}

export function ImageNotice(props: { codes: readonly string[]; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{refusedImagesText(props.codes)}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}

/** A failed Copy Image or Save Image As, in the window that ran it. */
export function ImageActionNotice() {
  const failure = useImageActionFailure()
  if (!failure) return null
  const text = t(failure.action === 'copy' ? 'images.copyFailed' : 'images.saveFailed')
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{format(text, { code: failure.code })}</span>
      <button type="button" className="button" onClick={dismissImageActionFailure}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
