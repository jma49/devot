// devot-mcp: Devot's notes for MCP clients (Claude Code, Claude Desktop) over
// stdio. It runs the core library on Devot's SQLite file, with or without
// Devot running. stdout carries MCP messages only; logs go to stderr as
// codes and IDs, never note content.
//
//   node dist-mcp/devot-mcp.mjs [--db <path to devot.sqlite>]
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAiService, type AiService } from '../core/ai'
import { createClock } from '../core/hlc'
import { createIdGenerator } from '../core/ids'
import type { Writer } from '../core/authorship'
import { clientWriter, createServer, errorCode, SERVER_VERSION, type Log } from './server'
import { openSqliteAdapter, SCHEMA_VERSION, type SqliteAdapter } from './sqlite'

/** Where Devot keeps its database on macOS. */
export const DEFAULT_DB = join(
  homedir(),
  'Library',
  'Application Support',
  'io.github.jma49.devot',
  'devot.sqlite',
)

const USAGE = `devot-mcp ${SERVER_VERSION}: Devot notes for MCP clients, over stdio.

Usage: devot-mcp [--db <path>]

  --db <path>   Devot's database (default: ${DEFAULT_DB})
  --help        Show this help
  --version     Show the version

Only notebooks with Allow AI Access on are visible.
`

const log: Log = (code, ...ids) => {
  process.stderr.write(`devot-mcp ${[code, ...ids].join(' ')}\n`)
}

function parseArgs(argv: readonly string[]): { db: string } | { exit: string; code: number } {
  let db = DEFAULT_DB
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { exit: USAGE, code: 0 }
    if (arg === '--version') return { exit: `${SERVER_VERSION}\n`, code: 0 }
    if (arg === '--db' && argv[i + 1]) db = argv[(i += 1)]!
    else if (arg?.startsWith('--db=') && arg.length > 5) db = arg.slice(5)
    else return { exit: `E_MCP_USAGE\n\n${USAGE}`, code: 2 }
  }
  return { db }
}

/** A random HLC node ID for this run, apart from every app install's; its writers' `process` too. */
const NODE = `mcp${randomBytes(6).toString('hex')}`
// One clock for the run, kept when the database is opened again, so no two stamps are alike.
const clock = createClock(NODE)

/**
 * The AI service on the database, opened on first use, so devot-mcp starts
 * even before Devot has created its database. Before each call the schema
 * is checked again: if Devot was upgraded meanwhile, the connection is
 * dropped and the next open reports why it cannot continue.
 */
function connector(path: string, writer: () => Writer) {
  let open: { adapter: SqliteAdapter; ai: AiService } | undefined
  const connect = (): AiService => {
    if (open && open.adapter.schemaVersion() !== SCHEMA_VERSION) {
      open.adapter.close()
      open = undefined
    }
    if (!open) {
      const adapter = openSqliteAdapter(path, { migrate: false })
      const ai = createAiService({
        storage: adapter,
        clock,
        newId: createIdGenerator(),
        atomically: adapter.atomically,
        writer,
        log,
      })
      open = { adapter, ai }
      log('I_MCP_DB_OPENED', `v${SCHEMA_VERSION}`)
    }
    return open.ai
  }
  const close = () => {
    open?.adapter.close()
    open = undefined
  }
  return { connect, close }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if ('exit' in args) {
    ;(args.code === 0 ? process.stdout : process.stderr).write(args.exit)
    process.exitCode = args.code
    return
  }
  const server = createServer({ service: () => db.connect(), log })
  const db = connector(args.db, clientWriter(server, NODE))
  const transport = new StdioServerTransport()
  transport.onclose = () => db.close()
  await server.connect(transport)
  log('I_MCP_STARTED')
}

main().catch((error: unknown) => {
  log('E_MCP_START_FAILED', errorCode(error))
  process.exitCode = 1
})
