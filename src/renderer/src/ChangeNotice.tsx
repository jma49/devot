import { changeMessage } from './changeMessage'
import { Notice } from './Notices'

export function ChangeNotice(props: { code: string; onDismiss: () => void }) {
  return <Notice text={changeMessage(props.code)} onDismiss={props.onDismiss} />
}
