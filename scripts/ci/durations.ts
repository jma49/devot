import { existsSync, readFileSync } from 'node:fs'

/**
 * Recorded durations by file, from the first of `paths` that holds a JSON object of positive
 * numbers: main's last full run restored from the cache, then the committed baseline. None gives {}.
 */
export function readDurations(...paths: (string | undefined)[]): Record<string, number> {
  for (const path of paths) {
    if (!path || !existsSync(path)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
      )
        return parsed as Record<string, number>
    } catch {}
    console.error(`E_DURATIONS_UNREADABLE ${path}`)
  }
  return {}
}
