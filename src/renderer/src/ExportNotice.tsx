import { format, t, type MessageKey } from './i18n'
import type { ExportAction } from './noteMenu'

/** What did not complete: an export (a PDF too), a print, a copy, or a copy of note links. */
export type ExportFailure = 'export' | 'print' | 'copy' | 'copyLink' | 'copyLinks'

/** What a failure of a note's export or print action is. */
export function failureOf(action: ExportAction): ExportFailure {
  if (action === 'print') return 'print'
  if (action === 'copyHtml' || action === 'copySimpleHtml') return 'copy'
  return 'export'
}

const MESSAGES: Record<ExportFailure, MessageKey> = {
  export: 'export.failed',
  print: 'export.printFailed',
  copy: 'export.copyFailed',
  copyLink: 'export.copyLinkFailed',
  copyLinks: 'export.copyLinksFailed',
}

/** Tells the user an export, print or copy did not complete, with its code. */
export function ExportNotice(props: {
  failure: ExportFailure
  code: string
  onDismiss: () => void
}) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">
        {format(t(MESSAGES[props.failure]), { code: props.code })}
      </span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
