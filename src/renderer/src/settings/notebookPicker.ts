import { errorCode } from '../backups'
import { invoke } from '../ipc'

/** Opens the AI access picker, which lives in the main window: Rust focuses or opens one and tells it. */
export function openNotebookPicker() {
  void invoke('ai_access_picker_open').catch((e: unknown) =>
    console.warn('W_AI_ACCESS_PICKER_OPEN_FAILED', errorCode(e)),
  )
}
