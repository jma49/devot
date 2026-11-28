import { aiSuggestFailure } from './aiEditView'
import { LICENCE_REQUIRED } from './licence'
import { LicenceButton } from './LicenceLocked'
import { Notice } from './Notices'

export function AiSuggestNotice(props: { code: string; onDismiss: () => void }) {
  return (
    <Notice text={aiSuggestFailure(props.code)} onDismiss={props.onDismiss}>
      {props.code === LICENCE_REQUIRED ? <LicenceButton /> : null}
    </Notice>
  )
}
