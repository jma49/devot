// devot-mcp's tools: list_notebooks, search_notes, read_note, create_note.
// Each one runs the core's AI service, which sees only notebooks with Allow
// AI Access on. Results are JSON text; errors are codes with a short hint,
// never note content.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { AI_SEARCH_LIMIT, MAX_AI_BODY_BYTES, MAX_AI_SEARCH_LIMIT, type AiService } from '../core/ai'
import { MAX_NOTE_LINKS } from '../core/links'
import { MAX_TITLE_CHARS } from '../core/noteLimits'

export const SERVER_NAME = 'devot'
export const SERVER_VERSION = '0.1.0'

/** Writes one log line (stderr in the CLI): a code and IDs only. */
export type Log = (code: string, ...ids: string[]) => void

export interface ServerOptions {
  /** The AI service on an open database; throws an error code when it cannot. */
  service: () => AiService
  log: Log
}

const HINTS: Record<string, string> = {
  E_NOTE_NOT_FOUND: 'No note with this ID is available to AI.',
  E_BOOK_NOT_FOUND:
    'No notebook with this ID or exact name allows AI access. Call list_notebooks to see them.',
  E_BOOK_AMBIGUOUS: 'Several notebooks that allow AI access have this name; pass the notebook ID.',
  E_SEARCH_QUERY_EMPTY: 'The query has no search terms.',
  E_NOTE_TITLE_INVALID: `The title must be one line of 1 to ${MAX_TITLE_CHARS} characters.`,
  E_NOTE_BODY_TOO_LARGE: `The Markdown body must be at most ${MAX_AI_BODY_BYTES} bytes.`,
  E_NOTE_LINKS_TOO_MANY: `The Markdown body may link to at most ${MAX_NOTE_LINKS} notes.`,
  E_STORAGE_NOT_FOUND: 'No Devot database at this path. Open Devot once, or pass --db <path>.',
  E_STORAGE_SCHEMA_TOO_OLD:
    'The database is from an older Devot. Open Devot once so it can upgrade the database.',
  E_STORAGE_SCHEMA_TOO_NEW: 'The database is from a newer Devot. Update devot-mcp.',
  E_STORAGE_BUSY: 'Devot is busy writing. Try again.',
  E_STORAGE_OPEN_FAILED: 'The Devot database could not be opened. Check the --db path.',
}

const CODE = /^E_[A-Z0-9_]+$/

/** The error code of a failure; anything else is internal. */
export function errorCode(error: unknown): string {
  if (error instanceof Error && CODE.test(error.message)) return error.message
  const sqlite = (error as { code?: unknown } | null)?.code
  // Extended codes too, such as SQLITE_BUSY_RECOVERY.
  if (typeof sqlite === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(sqlite)) {
    return 'E_STORAGE_BUSY'
  }
  return 'E_MCP_INTERNAL'
}

const json = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const iso = (ms: number) => new Date(ms).toISOString()

export function createServer({ service, log }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Devot is a Markdown note app. These tools see only notebooks whose owner turned on ' +
        'Allow AI Access, and only the notes filed directly in them. Notes are Markdown.',
    },
  )

  /** Runs a tool; a failure becomes an error result with its code. */
  const run =
    <A>(tool: string, work: (ai: AiService, args: A) => Promise<unknown>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return json(await work(service(), args))
      } catch (error) {
        const code = errorCode(error)
        log('W_MCP_TOOL_FAILED', tool, code)
        const hint = HINTS[code] ?? 'Devot could not complete the request.'
        return { isError: true, content: [{ type: 'text', text: `${code}: ${hint}` }] }
      }
    }

  server.registerTool(
    'list_notebooks',
    {
      title: 'List notebooks',
      description:
        'Lists the Devot notebooks that allow AI access, with their IDs and how many notes ' +
        'each holds. Notes can only be created in these notebooks.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('list_notebooks', async (ai) => ({ notebooks: await ai.notebooks() })),
  )

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search over the titles and Markdown of notes in notebooks that allow AI ' +
        'access. Every word must appear (case-insensitive substrings); "quote" a phrase, put - ' +
        'before a word to exclude it, and narrow with title:, body:, book:, tag: or status: ' +
        '(quote names with spaces: book:"Weekly notes"). ' +
        'Returns the best matches with a snippet of each; read_note gives the full text.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(1_000)
          .describe('Words, "quoted phrases", -exclusions and qualifiers such as tag:name'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_AI_SEARCH_LIMIT)
          .optional()
          .describe(`Most results to return (default ${AI_SEARCH_LIMIT})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run(
      'search_notes',
      async (ai, { query, limit }: { query: string; limit?: number | undefined }) => ({
        results: (await ai.search(query, limit)).map((hit) => ({
          ...hit,
          updatedAt: iso(hit.updatedAt),
        })),
      }),
    ),
  )

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description:
        'Reads one note by ID: its Markdown, title, notebook, status, pinned state, tags ' +
        'and times. Only notes in notebooks that allow AI access can be read.',
      inputSchema: { id: z.string().max(100).describe('The note ID (from search_notes)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('read_note', async (ai, { id }: { id: string }) => {
      const note = await ai.read(id)
      return { ...note, createdAt: iso(note.createdAt), updatedAt: iso(note.updatedAt) }
    }),
  )

  server.registerTool(
    'create_note',
    {
      title: 'Create a note',
      description:
        'Creates a note in a notebook that allows AI access, named by ID or exact name ' +
        '(see list_notebooks). The body is Markdown. Returns the new note ID.',
      inputSchema: {
        // The core checks the title's real limit (characters, after trimming).
        title: z
          .string()
          .max(MAX_TITLE_CHARS * 4)
          .describe('One line'),
        markdown: z.string().describe('The note body, in Markdown'),
        notebook: z.string().min(1).max(500).describe('A notebook ID or exact name'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    run('create_note', async (ai, input: { title: string; markdown: string; notebook: string }) => {
      const created = await ai.create(input)
      log('I_MCP_NOTE_CREATED', created.id, created.notebook.id)
      return created
    }),
  )

  return server
}
