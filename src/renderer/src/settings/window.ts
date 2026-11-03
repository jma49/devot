// What the Settings window asks of Rust beyond the settings themselves
// (src-tauri/src/settings.rs, mcp_clients.rs, background.rs, cli_tool.rs).
import { invoke } from '../ipc'
import { asCrashReports, type CrashReports } from '../crashReports'
import {
  asMcpAccess,
  asMcpClientStatus,
  asMcpSetup,
  asRunMode,
  type McpAccess,
  type McpClient,
  type McpClientStatus,
  type McpScope,
  type McpSetup,
  type RunMode,
} from './mcpConfigs'

export function openDataFolder(): Promise<void> {
  return invoke('settings_open_data_folder')
}

export function showBackups(): Promise<void> {
  return invoke('settings_show_backups')
}

export async function setCrashReports(on: boolean): Promise<CrashReports | null> {
  return asCrashReports(await invoke<unknown>('crash_reports_set', { on }))
}

export async function mcpSetup(): Promise<McpSetup> {
  const setup = asMcpSetup(await invoke<unknown>('settings_mcp_setup'))
  if (!setup) throw new Error('E_MCP_SETUP_INVALID')
  return setup
}

async function changeMcpClient(
  command: string,
  client: McpClient,
  revision: string,
): Promise<McpClientStatus> {
  const status = asMcpClientStatus(await invoke<unknown>(command, { client, revision }))
  if (!status) throw new Error('E_MCP_SETUP_INVALID')
  return status
}

/** `revision` is the file as shown: Rust refuses once it has changed since. */
export function connectMcpClient(client: McpClient, revision: string): Promise<McpClientStatus> {
  return changeMcpClient('settings_mcp_connect', client, revision)
}

export function disconnectMcpClient(client: McpClient, revision: string): Promise<McpClientStatus> {
  return changeMcpClient('settings_mcp_disconnect', client, revision)
}

export function openMcpExtension(): Promise<void> {
  return invoke('settings_mcp_open_extension')
}

function readMcpAccess(value: unknown): McpAccess {
  const access = asMcpAccess(value)
  if (!access) throw new Error('E_MCP_ACCESS_INVALID')
  return access
}

export async function loadMcpAccess(): Promise<McpAccess> {
  return readMcpAccess(await invoke<unknown>('mcp_access_get'))
}

export async function saveMcpAccess(change: {
  enabled: boolean
  scope: McpScope
  backgroundStart: boolean
}): Promise<McpAccess> {
  return readMcpAccess(await invoke<unknown>('mcp_access_set', change))
}

export async function loadRunMode(): Promise<RunMode> {
  const mode = asRunMode(await invoke<unknown>('background_state'))
  if (!mode) throw new Error('E_BACKGROUND_STATE_INVALID')
  return mode
}

/** Quits as the app menu does, so pending saves are flushed first. */
export function quitDevot(): Promise<void> {
  return invoke('background_quit')
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
