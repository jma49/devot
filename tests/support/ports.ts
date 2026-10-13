import { createHash } from 'node:crypto'

// The ports of the UI tests' two servers (playwright.config.ts). Each
// checkout gets a pair of its own, derived from the folder it is in, so two
// checkouts (parallel worktrees) run their suites side by side without
// meeting on one port. The range stays clear of ports a browser refuses.

const FIRST = 5200
/** Pairs in the range: 5200-5999. */
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

/**
 * The dev server's and the production-CSP server's ports for the checkout at
 * `root`. `DEVOT_UI_PORT` and `DEVOT_CSP_PORT` override either one.
 */
export function uiPorts(root: string, env: Readonly<Record<string, string | undefined>>): UiPorts {
  const pair = createHash('sha256').update(root).digest().readUInt32BE(0) % PAIRS
  const ui = fromEnv(env['DEVOT_UI_PORT']) ?? FIRST + pair * 2
  const csp = fromEnv(env['DEVOT_CSP_PORT']) ?? FIRST + pair * 2 + 1
  return { ui, csp }
}

/**
 * Whether a run may reuse servers that already answer on its ports. Never on
 * CI, and locally only when asked (`DEVOT_REUSE_SERVERS=1`): a server that is
 * already there may be another checkout's, or an old build, and a reused
 * server also skips the build of the production-CSP bundle.
 */
export function reuseServers(env: Readonly<Record<string, string | undefined>>): boolean {
  return !env['CI'] && env['DEVOT_REUSE_SERVERS'] === '1'
}
