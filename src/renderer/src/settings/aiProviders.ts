// What the Settings window asks of Rust for the AI providers
// (src-tauri/src/ai). A key goes in with ai_key_set and is never read back.
import {
  asAiCatalogs,
  asAiSettingsView,
  asAiTried,
  type AiApiProviderId,
  type AiCatalogs,
  type AiProviderId,
  type AiSettingsChange,
  type AiSettingsView,
  type AiTried,
} from '../../../core/aiProvider'
import { invoke } from '../ipc'

async function view(command: string, args?: Record<string, unknown>): Promise<AiSettingsView> {
  const settings = asAiSettingsView(await invoke<unknown>(command, args))
  if (!settings) throw new Error('E_AI_SETTINGS_INVALID')
  return settings
}

export const loadAiSettings = () => view('ai_settings_get')

export const saveAiSettings = (settings: AiSettingsChange) => view('ai_settings_set', { settings })

export const saveAiKey = (provider: AiApiProviderId, key: string) =>
  view('ai_key_set', { provider, key })

export const removeAiKey = (provider: AiApiProviderId) => view('ai_key_clear', { provider })

export const refreshAiCli = () => view('ai_cli_refresh')

/**
 * The models of each provider named, from Rust's last lists unless `refresh`.
 * An HTTP provider's list goes to its server with the stored key, so ask for it only when the user opens that provider.
 */
export async function loadAiModels(
  providers: readonly AiProviderId[],
  refresh = false,
): Promise<AiCatalogs> {
  const catalogs = asAiCatalogs(await invoke<unknown>('ai_models', { providers, refresh }))
  if (!catalogs) throw new Error('E_AI_RESPONSE_INVALID')
  return catalogs
}

/** Try It: Rust sends a fixed prompt, never note text, and says how long the answer took. */
export async function tryAiModel(
  provider: AiProviderId,
  model: string,
  reasoning: string | null,
): Promise<AiTried> {
  const tried = asAiTried(await invoke<unknown>('ai_try', { provider, model, reasoning }))
  if (!tried) throw new Error('E_AI_RESPONSE_INVALID')
  return tried
}
