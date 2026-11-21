import { CHOOSE_AI_ACCESS } from '../aiAccess'
import { errorCode } from '../backups'
import { showMainWindow } from './window'

/** Opens the AI access picker in the main window: the flag in the storage both windows share asks it to. */
export function openNotebookPicker() {
  try {
    localStorage.setItem(CHOOSE_AI_ACCESS, '1')
  } catch {
    // Without the shared storage the main window still opens; the picker is one menu away.
  }
  void showMainWindow().catch((e: unknown) =>
    console.warn('W_MAIN_WINDOW_SHOW_FAILED', errorCode(e)),
  )
}
