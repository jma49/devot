// Why a file or folder was not imported, in the user's words: import
// problem codes (src-tauri/src/import.rs, src/core/import.ts) to catalog keys.
import type { MessageKey } from './i18n'

const REASONS: Record<string, MessageKey> = {
  E_IMPORT_FILE_TOO_LARGE: 'import.reason.tooLarge',
  E_FILE_SIZE_INVALID: 'import.reason.size',
  E_IMPORT_NOT_UTF8: 'import.reason.notUtf8',
  E_IMPORT_FILE_NOT_FOUND: 'import.reason.notFound',
  E_IMPORT_PATH_OUTSIDE: 'import.reason.outside',
  E_IMPORT_LINK_OUTSIDE: 'import.reason.outside',
  E_FILE_TYPE_REFUSED: 'import.reason.type',
  E_IMPORT_PATH_INVALID: 'import.reason.path',
  E_IMPORT_UNREADABLE: 'import.reason.unreadable',
  E_IMPORT_TOO_DEEP: 'import.reason.tooDeep',
  E_IMPORT_NAME_INVALID: 'import.reason.name',
  E_IMPORT_TOO_MANY_FILES: 'import.reason.tooManyFiles',
  E_IMPORT_FOLDER_TOO_LARGE: 'import.reason.folderTooLarge',
  E_IMPORT_ROOT_INVALID: 'import.reason.folderInvalid',
  E_IMPORT_LINK_HIDDEN: 'import.reason.linkHidden',
  E_IMPORT_IMAGE_UNLOCATED: 'import.reason.unlocated',
  E_IMPORT_INCOMPLETE: 'import.reason.incomplete',
  E_IMPORT_SESSION: 'import.reason.session',
  E_IMPORT_STOPPED: 'import.reason.stopped',
  E_IMPORT_PATH_UNKNOWN: 'import.reason.path',
  E_FILE_NAME_INVALID: 'import.reason.name',
}

/** Why a file or folder was not imported, for the user. */
export function importReason(code: string): MessageKey | null {
  return Object.hasOwn(REASONS, code) ? (REASONS[code] ?? null) : null
}
