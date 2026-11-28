import { countOf } from './format'
import { currentLocale } from './i18n'
import { Notice } from './Notices'

export function BatchNotice(props: { failed: number; onDismiss: () => void }) {
  return (
    <Notice
      text={countOf(props.failed, currentLocale(), 'batch.failedOne', 'batch.failedOther')}
      onDismiss={props.onDismiss}
    />
  )
}
