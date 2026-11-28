import { failureText } from './failure'
import { Notice } from './Notices'

/**
 * Tells the user that the core worker, which holds the notes and saves them,
 * raised an error after it started. The window keeps running with it, so
 * this does not stop work; it says what to do if saving stops.
 */
export function CoreNotice(props: { code: string; onDismiss: () => void }) {
  return <Notice text={failureText('core.failed', props.code)} onDismiss={props.onDismiss} />
}
