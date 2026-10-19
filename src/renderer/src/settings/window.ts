// What the Settings window asks of Rust beyond the settings themselves
// (src-tauri/src/settings.rs): opening the app's data folder in Finder,
// showing the Backups dialog and where devot-mcp is.
import { invoke } from '../ipc'
import { asMcpSetup, type McpSetup } from './mcpConfigs'

export function openDataFolder(): Promise<void> {
  return invoke('settings_open_data_folder')
}

export function showBackups(): Promise<void> {
  return invoke('settings_show_backups')
}

export async function mcpSetup(): Promise<McpSetup> {
  const setup = asMcpSetup(await invoke<unknown>('settings_mcp_setup'))
  if (!setup) throw new Error('E_MCP_SETUP_INVALID')
  return setup
}
