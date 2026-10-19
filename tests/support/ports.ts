import { createHash } from 'node:crypto'

// Ports of the UI tests' two servers (playwright.config.ts). Each checkout derives its own pair from its
// folder, so parallel worktrees run side by side; the range avoids ports a browser refuses.

const FIRST = 5200
const PAIRS = 400

export interface UiPorts {
  ui: number
  csp: number
}

function fromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Not a port: ${value}`)
  }
  return port
}

/** Dev and production-CSP server ports for the checkout at `root`; `DEVOT_UI_PORT` / `DEVOT_CSP_PORT` override. */
export function uiPorts(root: string, env: Readonly<Record<string, string | undefined>>): UiPorts {
  const pair = createHash('sha256').update(root).digest().readUInt32BE(0) % PAIRS
  const ui = fromEnv(env['DEVOT_UI_PORT']) ?? FIRST + pair * 2
  const csp = fromEnv(env['DEVOT_CSP_PORT']) ?? FIRST + pair * 2 + 1
  return { ui, csp }
}

/**
 * Whether to reuse servers already on the ports: never on CI, locally only with `DEVOT_REUSE_SERVERS=1`.
 * One already there may be another checkout's or an old build, and reuse skips the production-CSP build.
 */
export function reuseServers(env: Readonly<Record<string, string | undefined>>): boolean {
  return !env['CI'] && env['DEVOT_REUSE_SERVERS'] === '1'
}
