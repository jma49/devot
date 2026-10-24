// What the Settings window asks of Rust for the local HTTP API
// (src-tauri/src/http_api). The token stays in the keychain; Settings reads it
// only when asked to show it.
import { invoke } from '../ipc'

export type HttpApiScope = 'read' | 'readWrite'
export type HttpApiTokenState = 'set' | 'unset' | 'unknown' | 'unavailable'

export interface HttpApiView {
  enabled: boolean
  port: number
  scope: HttpApiScope
  /** The port it listens on, while it does. */
  listening: number | null
  /** Why it is on but not listening. */
  problem: string | null
  token: HttpApiTokenState
}

export const HTTP_API_MIN_PORT = 1024
export const HTTP_API_MAX_PORT = 65_535

const SCOPES: readonly unknown[] = ['read', 'readWrite']
const TOKEN_STATES: readonly unknown[] = ['set', 'unset', 'unknown', 'unavailable']

const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= HTTP_API_MAX_PORT

export function asHttpApiView(value: unknown): HttpApiView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { enabled, port, scope, listening, problem, token } = value as Record<string, unknown>
  if (typeof enabled !== 'boolean' || !isPort(port) || !SCOPES.includes(scope)) return undefined
  if (listening !== null && !isPort(listening)) return undefined
  if (problem !== null && typeof problem !== 'string') return undefined
  if (!TOKEN_STATES.includes(token)) return undefined
  return {
    enabled,
    port,
    scope: scope as HttpApiScope,
    listening,
    problem,
    token: token as HttpApiTokenState,
  }
}

async function view(command: string, args?: Record<string, unknown>): Promise<HttpApiView> {
  const found = asHttpApiView(await invoke<unknown>(command, args))
  if (!found) throw new Error('E_HTTP_API_VIEW_INVALID')
  return found
}

export const loadHttpApi = () => view('http_api_get')

export const saveHttpApi = (enabled: boolean, port: number) =>
  view('http_api_set', { enabled, port })

/** A new token of `scope`; the one before stops working. */
export const newHttpApiToken = (scope: HttpApiScope) => view('http_api_token_rotate', { scope })

export async function revealHttpApiToken(): Promise<string> {
  const token = await invoke<unknown>('http_api_token_reveal')
  if (typeof token !== 'string') throw new Error('E_HTTP_API_TOKEN_INVALID')
  return token
}

/** A request to try the API with, the token left to the shell. */
export const curlExample = (port: number) =>
  `curl -H "Authorization: Bearer $DEVOT_TOKEN" http://127.0.0.1:${port}/v1/notebooks`
