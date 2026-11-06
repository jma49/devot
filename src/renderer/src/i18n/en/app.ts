export const prefixes = [
  'save',
  'noteWindow',
  'start',
  'core',
  'change',
  'notice',
  'dialog',
  'failure',
]

export const messages = {
  'dialog.cancel': 'Cancel',
  'dialog.save': 'Save',
  'failure.offline': 'Devot could not connect. Check the connection and try again.',
  'failure.timeout': 'It took too long. Try again.',
  'failure.addressRefused': 'Devot does not connect to that address.',
  'failure.serverRefused': 'The server refused the request.',
  'failure.serverUnavailable': 'The server is not available now. Try again later.',
  'failure.unavailable': 'Something it needs is not available now. Try again later.',
  'notice.undo': 'Undo',
  'notice.dismiss': 'Dismiss',
  'save.failedOne': 'Changes to {count} note could not be saved. Devot keeps trying.',
  'save.failedOther': 'Changes to {count} notes could not be saved. Devot keeps trying.',
  'save.quitHeldOne':
    'Devot did not quit: changes to {count} note could not be saved. It keeps trying; quit again to quit without them.',
  'save.quitHeldOther':
    'Devot did not quit: changes to {count} notes could not be saved. It keeps trying; quit again to quit without them.',
  'save.closeHeldOne':
    'The window did not close: changes to {count} note could not be saved. Devot keeps trying; close it again to close it without them.',
  'save.closeHeldOther':
    'The window did not close: changes to {count} notes could not be saved. Devot keeps trying; close it again to close it without them.',
  'noteWindow.unavailable': 'This note cannot be opened. It may have been deleted.',
  'noteWindow.trashed':
    'This note is in the Trash, so this window cannot save changes. Restore it in Devot to edit it again.',
  'noteWindow.purged':
    'This note was deleted for good, so this window cannot save changes. Its text stays here, read-only.',
  'save.retry': 'Try Again',
  'start.failed': 'Devot could not load your notes.',
  'start.detail': 'Choose Help > Export Diagnostics\u2026 to save a report you can share.',
  'start.retry': 'Try Again',
  'core.failed':
    'Something went wrong inside Devot. If your changes stop saving, quit and open Devot again.',
  'change.failed': 'The change could not be made.',
  'change.tagNameTaken': 'Another tag already has that name.',
  'change.tagNameInvalid': 'A tag name is one line of at most {max} characters.',
  'change.tagRenameSearchTooLong':
    'This tag cannot take that name: a saved search that uses it would pass {max} characters. Shorten the name or edit that search.',
  'change.noteNotTrashed':
    'This note is no longer in the Trash, so it was not deleted. It may have been restored in another window or on another device.',
  'change.bookNameInvalid': 'A notebook name is one line of at most {max} characters.',
} as const
