// A plugin's theme file (ADR 0026), checked by the rules Rust checks it by (`theme_colors`, src-tauri/src/plugins/package.rs).
export const THEME_LIMITS = { bytes: 64 * 1024, colors: 2048 }
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const KEY_MAX = 64
const COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Colors by token, lowercased; throws `E_PLUGIN_THEME_INVALID`. */
export function parseThemeFile(bytes: Uint8Array): Record<string, string> {
  const fail = (): never => {
    throw new Error('E_PLUGIN_THEME_INVALID')
  }
  if (bytes.length > THEME_LIMITS.bytes) fail()
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return fail()
  }
  const colors = (value as { colors?: unknown } | null)?.colors
  if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) return fail()
  const entries = Object.entries(colors)
  if (entries.length === 0 || entries.length > THEME_LIMITS.colors) fail()
  const out: Record<string, string> = {}
  for (const [key, color] of entries) {
    if (key.length > KEY_MAX || !KEY.test(key) || typeof color !== 'string' || !COLOR.test(color)) {
      fail()
    }
    out[key] = (color as string).toLowerCase()
  }
  return out
}
