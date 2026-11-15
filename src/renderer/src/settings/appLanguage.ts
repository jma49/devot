// Settings > General > Language (src-tauri/src/app_language.rs): the system's languages, or one
// chosen for Devot alone, shown from the next launch.
import { invoke } from '../ipc'
import { t } from '../i18n'

export const APP_LANGUAGES = ['system', 'en', 'zh-Hans'] as const
export type AppLanguage = (typeof APP_LANGUAGES)[number]

export interface LanguageState {
  chosen: AppLanguage
  /** What this run shows: a restart is offered while it differs from `chosen`. */
  running: AppLanguage
  /** False where Devot cannot set its own language. */
  available: boolean
}

const isLanguage = (value: unknown): value is AppLanguage =>
  APP_LANGUAGES.includes(value as AppLanguage)

export function asLanguageState(value: unknown): LanguageState | null {
  if (typeof value !== 'object' || value === null) return null
  const { chosen, running, available } = value as Record<string, unknown>
  return isLanguage(chosen) && isLanguage(running) && typeof available === 'boolean'
    ? { chosen, running, available }
    : null
}

/** Each language by its own name, so a reader lost in the other one still finds theirs. */
export function languageName(language: AppLanguage): string {
  if (language === 'system') return t('generalSettings.language.system')
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language
  } catch {
    return language
  }
}

async function answer(value: Promise<unknown>): Promise<LanguageState> {
  const state = asLanguageState(await value)
  if (!state) throw new Error('E_APP_LANGUAGE_INVALID')
  return state
}

export function appLanguage(): Promise<LanguageState> {
  return answer(invoke<unknown>('app_language_get'))
}

export function setAppLanguage(language: AppLanguage): Promise<LanguageState> {
  return answer(invoke<unknown>('app_language_set', { language }))
}

export function restartForLanguage(): Promise<void> {
  return invoke('app_language_restart')
}
