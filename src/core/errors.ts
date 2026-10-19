// Error codes: what a failure carries on its way to a notice, the log and
// crash reports. A code is `E_`, `W_` or `I_` and capitals, digits and
// underscores, as Rust's `logs::is_code` reads one. A failure's text may go
// on after its code (`E_STORAGE_SCHEMA_TOO_NEW v13`); only the code is kept,
// since the rest is not known to be free of note content.

const CODE = /^[EWI]_[A-Z0-9_]{1,62}(?![A-Za-z0-9_])/

/** The code of an Error message, or of the text a Tauri command rejects with (Rust sends its code as a string); else `fallback`. */
export function errorCode(error: unknown, fallback = 'E_UNKNOWN'): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CODE.exec(text)?.[0] ?? fallback
}
