import { t } from './i18n'
import { failureText } from './failure'
import { Notice } from './Notices'

export function BackupNotice(props: { code: string; onShow: () => void; onDismiss: () => void }) {
  return (
    <Notice text={failureText('backups.autoFailed', props.code)} onDismiss={props.onDismiss}>
      <button type="button" className="button" onClick={props.onShow}>
        {t('backups.show')}
      </button>
    </Notice>
  )
}
