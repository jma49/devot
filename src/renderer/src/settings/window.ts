// What the Settings window asks of Rust beyond the settings themselves
// (src-tauri/src/settings.rs, cli_tool.rs).
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

export type CliToolState = 'installed' | 'absent' | 'other' | 'unavailable'

export interface CliToolStatus {
  state: CliToolState
  path: string
}

const CLI_TOOL_STATES: readonly string[] = ['installed', 'absent', 'other', 'unavailable']

export function asCliToolStatus(value: unknown): CliToolStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { state, path } = value as Record<string, unknown>
  if (typeof state !== 'string' || !CLI_TOOL_STATES.includes(state)) return undefined
  if (typeof path !== 'string') return undefined
  return { state: state as CliToolState, path }
}

async function cliTool(command: string): Promise<CliToolStatus> {
  const status = asCliToolStatus(await invoke<unknown>(command))
  if (!status) throw new Error('E_CLI_TOOL_STATUS_INVALID')
  return status
}

export const cliToolStatus = () => cliTool('cli_tool_status')

export const installCliTool = () => cliTool('cli_tool_install')

export const uninstallCliTool = () => cliTool('cli_tool_uninstall')
