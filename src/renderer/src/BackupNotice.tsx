import { format, t } from './i18n'

export function BackupNotice(props: { code: string; onShow: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="notice" data-devot-part="notice">
      <span className="notice-text">{format(t('backups.autoFailed'), { code: props.code })}</span>
      <button type="button" className="button" onClick={props.onShow}>
        {t('backups.show')}
      </button>
      <button type="button" className="button" onClick={props.onDismiss}>
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
