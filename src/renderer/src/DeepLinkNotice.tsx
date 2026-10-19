import { t, type MessageKey } from './i18n'

export type DeepLinkProblem = 'noteNotFound' | 'commandUnavailable' | 'importFailed'

const TEXT: Readonly<Record<DeepLinkProblem, MessageKey>> = {
  noteNotFound: 'deepLink.noteNotFound',
  commandUnavailable: 'deepLink.commandUnavailable',
  importFailed: 'deepLink.importFailed',
}

export function DeepLinkNotice(props: { problem: DeepLinkProblem; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice" data-devot-deep-link>
      <span className="notice-text">{t(TEXT[props.problem])}</span>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
