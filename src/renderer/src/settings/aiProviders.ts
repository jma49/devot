// What the Settings window asks of Rust for the AI providers
// (src-tauri/src/ai). A key goes in with ai_key_set and is never read back.
import {
  asAiSettingsView,
  type AiProviderId,
  type AiSettingsChange,
  type AiSettingsView,
} from '../../../core/aiProvider'
import { invoke } from '../ipc'

async function view(command: string, args?: Record<string, unknown>): Promise<AiSettingsView> {
  const settings = asAiSettingsView(await invoke<unknown>(command, args))
  if (!settings) throw new Error('E_AI_SETTINGS_INVALID')
  return settings
}

export const loadAiSettings = () => view('ai_settings_get')

export const saveAiSettings = (settings: AiSettingsChange) => view('ai_settings_set', { settings })

export const saveAiKey = (provider: AiProviderId, key: string) =>
  view('ai_key_set', { provider, key })

export const removeAiKey = (provider: AiProviderId) => view('ai_key_clear', { provider })
