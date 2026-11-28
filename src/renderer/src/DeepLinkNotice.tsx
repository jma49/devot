import { t, type MessageKey } from './i18n'
import { Notice } from './Notices'

export type DeepLinkProblem = 'noteNotFound' | 'commandUnavailable' | 'importFailed' | 'dropFailed'

const TEXT: Readonly<Record<DeepLinkProblem, MessageKey>> = {
  noteNotFound: 'deepLink.noteNotFound',
  commandUnavailable: 'deepLink.commandUnavailable',
  importFailed: 'deepLink.importFailed',
  dropFailed: 'import.dropFailed',
}

export function DeepLinkNotice(props: { problem: DeepLinkProblem; onDismiss: () => void }) {
  return <Notice text={t(TEXT[props.problem])} onDismiss={props.onDismiss} data-devot-deep-link />
}
