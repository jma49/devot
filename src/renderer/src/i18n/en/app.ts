export const prefixes = ['save', 'noteWindow', 'start', 'core', 'change', 'notice', 'dialog']

export const messages = {
  'dialog.cancel': 'Cancel',
  'dialog.save': 'Save',
  'notice.undo': 'Undo',
  'notice.dismiss': 'Dismiss',
  'save.failedOne': 'Changes to {count} note could not be saved ({code}). Devot keeps trying.',
  'save.failedOther': 'Changes to {count} notes could not be saved ({code}). Devot keeps trying.',
  'save.quitHeldOne':
    'Devot did not quit: changes to {count} note could not be saved ({code}). It keeps trying; quit again to quit without them.',
  'save.quitHeldOther':
    'Devot did not quit: changes to {count} notes could not be saved ({code}). It keeps trying; quit again to quit without them.',
  'save.closeHeldOne':
    'The window did not close: changes to {count} note could not be saved ({code}). Devot keeps trying; close it again to close it without them.',
  'save.closeHeldOther':
    'The window did not close: changes to {count} notes could not be saved ({code}). Devot keeps trying; close it again to close it without them.',
  'noteWindow.unavailable': 'This note cannot be opened ({code}). It may have been deleted.',
  'noteWindow.trashed':
    'This note is in the Trash, so this window cannot save changes. Restore it in Devot to edit it again.',
  'noteWindow.purged':
    'This note was deleted for good, so this window cannot save changes. Its text stays here, read-only.',
  'save.retry': 'Try Again',
  'start.failed': 'Devot could not load your notes.',
  'start.detail':
    'Error code: {code}. Choose Help > Export Diagnostics\u2026 to save a report you can share.',
  'start.retry': 'Try Again',
  'core.failed':
    'Something went wrong inside Devot ({code}). If your changes stop saving, quit and open Devot again.',
  'change.failed': 'The change could not be made ({code}).',
  'change.tagNameTaken': 'Another tag already has that name.',
  'change.tagNameInvalid': 'A tag name is one line of at most {max} characters.',
  'change.tagRenameSearchTooLong':
    'This tag cannot take that name: a saved search that uses it would pass {max} characters. Shorten the name or edit that search ({code}).',
  'change.noteNotTrashed':
    'This note is no longer in the Trash, so it was not deleted. It may have been restored in another window or on another device.',
  'change.bookNameInvalid': 'A notebook name is one line of at most {max} characters.',
} as const
