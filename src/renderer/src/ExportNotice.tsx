import { failureText } from './failure'
import { t, type MessageKey } from './i18n'
import type { ExportAction } from './noteMenu'

export type ExportFailure =
  | 'export'
  | 'partial'
  | 'print'
  | 'copy'
  | 'copyLink'
  | 'copyLinks'
  | 'copyId'

export function failureOf(action: ExportAction): ExportFailure {
  if (action === 'print') return 'print'
  if (action === 'copyHtml' || action === 'copySimpleHtml') return 'copy'
  return 'export'
}

const MESSAGES: Record<ExportFailure, MessageKey> = {
  export: 'export.failed',
  partial: 'export.partial',
  print: 'export.printFailed',
  copy: 'export.copyFailed',
  copyLink: 'export.copyLinkFailed',
  copyLinks: 'export.copyLinksFailed',
  copyId: 'export.copyIdFailed',
}

const stringValues = (values: Record<string, string | number> = {}) =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)]))

export function ExportNotice(props: {
  failure: ExportFailure
  code: string
  /** Values the message names (`partial`: what was written and what was not). */
  values?: Record<string, string | number> | undefined
  onDismiss: () => void
}) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">
        {failureText(MESSAGES[props.failure], props.code, stringValues(props.values))}
      </span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
