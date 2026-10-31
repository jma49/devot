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

export interface AiAccessSummary {
  /** Live notebooks, the Templates one left out. */
  notebooks: number
  /** How many of them allow AI access. */
  allowed: number
}

export function asAiAccessSummary(value: unknown): AiAccessSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { notebooks, allowed } = value as Record<string, unknown>
  if (typeof notebooks !== 'number' || typeof allowed !== 'number') return undefined
  if (!Number.isInteger(notebooks) || !Number.isInteger(allowed)) return undefined
  if (notebooks < 0 || allowed < 0 || allowed > notebooks) return undefined
  return { notebooks, allowed }
}

export async function aiAccessSummary(): Promise<AiAccessSummary> {
  const summary = asAiAccessSummary(await invoke<unknown>('settings_ai_access_summary'))
  if (!summary) throw new Error('E_AI_ACCESS_SUMMARY_INVALID')
  return summary
}

/** Focuses a main window, or opens one: the AI access picker opens there. */
export function showMainWindow(): Promise<void> {
  return invoke('main_window_show')
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
