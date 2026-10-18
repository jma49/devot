import { t, type MessageKey } from './i18n'

/** Why a link from another app could not be followed. */
export type DeepLinkProblem = 'noteNotFound' | 'commandUnavailable'

const TEXT: Readonly<Record<DeepLinkProblem, MessageKey>> = {
  noteNotFound: 'deepLink.noteNotFound',
  commandUnavailable: 'deepLink.commandUnavailable',
}

/** Tells the user that a devot:// link from another app could not be followed. */
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
