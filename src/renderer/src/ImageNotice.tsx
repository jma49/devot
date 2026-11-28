import { MAX_FILE_BYTES } from '../../core/files'
import { dismissImageActionFailure, useImageActionFailure } from './imageMenu'
import { countOf } from './format'
import { currentLocale, format, t, type MessageKey } from './i18n'
import { failureText } from './failure'
import { Notice } from './Notices'

const REASONS: Readonly<Record<string, MessageKey>> = {
  E_FILE_SIZE_INVALID: 'images.reason.size',
  E_FILE_TYPE_REFUSED: 'images.reason.type',
  E_FILE_NAME_INVALID: 'images.reason.name',
}

/** Each reason among `codes` once, in the order first met. */
export function refusedImagesText(codes: readonly string[]): string {
  const locale = currentLocale()
  const keys = new Set(codes.map((code) => REASONS[code] ?? 'images.reason.other'))
  const size = (MAX_FILE_BYTES / (1024 * 1024)).toLocaleString(locale)
  const reasons = [...keys].map((key) => format(t(key), { size })).join(' ')
  const text = countOf(codes.length, locale, 'images.refusedOne', 'images.refusedOther')
  return format(text, { reasons })
}

export function ImageNotice(props: { codes: readonly string[]; onDismiss: () => void }) {
  return <Notice text={refusedImagesText(props.codes)} onDismiss={props.onDismiss} />
}

/** A failed Copy Image or Save Image As, in the window that ran it (runImageAction logged its code). */
export function ImageActionNotice() {
  const failure = useImageActionFailure()
  if (!failure) return null
  const text = failureText(
    failure.action === 'copy' ? 'images.copyFailed' : 'images.saveFailed',
    failure.code,
  )
  return <Notice text={text} onDismiss={dismissImageActionFailure} />
}
