import { invoke } from './ipc'

export interface CrashReports {
  /** False in a build that can send none. */
  available: boolean
  on: boolean
}

export function asCrashReports(value: unknown): CrashReports | null {
  if (typeof value !== 'object' || value === null) return null
  const { available, on } = value as Record<string, unknown>
  return typeof available === 'boolean' && typeof on === 'boolean' ? { available, on } : null
}

export async function crashReports(): Promise<CrashReports | null> {
  return asCrashReports(await invoke<unknown>('crash_reports_get'))
}
