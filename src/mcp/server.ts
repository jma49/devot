// devot-mcp's tools: list_notebooks, search_notes, read_note, list_tags,
// create_note, update_note, trash_note and create_notebook. Each one runs the
// core's AI service, which sees only notebooks with Allow AI Access on.
// Results are JSON text; errors are codes with a short hint, never note
// content.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  AI_SEARCH_LIMIT,
  MAX_AI_BODY_BYTES,
  MAX_AI_PATCHES,
  MAX_AI_SEARCH_LIMIT,
  MAX_AI_TAGS,
  type AiNote,
  type AiNoteUpdate,
  type AiService,
} from '../core/ai'
import { newWriter, type Writer } from '../core/authorship'
import { MAX_BOOK_NAME_CHARS } from '../core/books'
import { MAX_NOTE_LINKS } from '../core/links'
import { MAX_BODY_BYTES, MAX_TITLE_CHARS } from '../core/noteLimits'
import { NOTE_STATUSES } from '../core/storage'
import { MAX_TAG_NAME_CHARS } from '../core/tags'

import { SERVER_NAME, SERVER_VERSION } from './version'

export { SERVER_NAME, SERVER_VERSION }

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
  E_NOTE_BODY_TOO_LARGE: `The Markdown sent (a body, or all patches together) must be at most ${MAX_AI_BODY_BYTES} bytes, and a patched note at most ${MAX_BODY_BYTES} bytes.`,
  E_NOTE_LINKS_TOO_MANY: `The Markdown body may link to at most ${MAX_NOTE_LINKS} notes.`,
  E_NOTE_STATUS_INVALID: `The status must be one of ${NOTE_STATUSES.join(', ')}.`,
  E_AI_UPDATE_EMPTY:
    'Nothing to change: pass a title, markdown, patches, notebook, tags or status.',
  E_AI_BODY_CONFLICT: 'Pass either markdown (the whole body) or patches, not both.',
  E_AI_PATCHES_INVALID: `Pass 1 to ${MAX_AI_PATCHES} patches, each with a non-empty find.`,
  E_AI_PATCH_NOT_FOUND:
    'A patch find text is not in the note body (as earlier patches left it). Read the note again and copy the text exactly.',
  E_AI_PATCH_AMBIGUOUS:
    'A patch find text occurs more than once in the note body. Include more surrounding text so it matches once.',
  E_AI_TAGS_TOO_MANY: `A note may be given at most ${MAX_AI_TAGS} tags at once.`,
  E_TAG_NAME_INVALID: `Each tag name must be one line of 1 to ${MAX_TAG_NAME_CHARS} characters and must not name a tag used only in notebooks without AI access.`,
  E_BOOK_NAME_INVALID: `The notebook name must be one line of 1 to ${MAX_BOOK_NAME_CHARS} characters.`,
  E_BOOK_NAME_TAKEN:
    'A notebook that allows AI access already has this name. Use it, or choose another name.',
  E_STORAGE_NOT_FOUND: 'No Devot database at this path. Open Devot once, or pass --db <path>.',
  E_STORAGE_SCHEMA_TOO_OLD:
    'The database is from an older Devot. Open Devot once so it can upgrade the database.',
  E_STORAGE_SCHEMA_TOO_NEW: 'The database is from a newer Devot. Update devot-mcp.',
  E_STORAGE_BUSY: 'Devot is busy writing. Try again.',
  E_STORAGE_OPEN_FAILED: 'The Devot database could not be opened. Check the --db path.',
  E_STORAGE_MODULE_FAILED:
    'The Devot database module could not load with this Node. Run devot-mcp with the Node that installed it, or reinstall it.',
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

/** A note as tools return it: times as ISO strings. */
const noteJson = (note: AiNote) => ({
  ...note,
  createdAt: iso(note.createdAt),
  updatedAt: iso(note.updatedAt),
})

const NOTE_ID = z.string().max(100)
const WRITES = { readOnlyHint: false, openWorldHint: false } as const

interface UpdateArgs {
  id: string
  title?: string | undefined
  markdown?: string | undefined
  patches?: { find: string; replace: string }[] | undefined
  notebook?: string | undefined
  tags?: string[] | undefined
  status?: AiNoteUpdate['status'] | undefined
}

/** The core's update for a tool call; E_AI_BODY_CONFLICT for both body forms. */
function toUpdate(args: UpdateArgs): AiNoteUpdate {
  if (args.markdown !== undefined && args.patches !== undefined) {
    throw new Error('E_AI_BODY_CONFLICT')
  }
  return {
    id: args.id,
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.markdown !== undefined
      ? { body: { markdown: args.markdown } }
      : args.patches !== undefined
        ? { body: { patches: args.patches } }
        : {}),
    ...(args.notebook === undefined ? {} : { notebook: args.notebook }),
    ...(args.tags === undefined ? {} : { tags: args.tags }),
    ...(args.status === undefined ? {} : { status: args.status }),
  }
}

/**
 * Who this connection's writes are recorded as (ADR 0007): one session for the connection, named
 * as the client introduced itself in `initialize`. The name is only shown, never trusted.
 */
export function clientWriter(server: McpServer, process: string): () => Writer {
  const session = newWriter('mcp', '', process).session
  return () => ({
    ...newWriter('mcp', server.server.getClientVersion()?.name ?? '', process),
    session,
  })
}

export function createServer({ service, log }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Devot is a Markdown note app. These tools see only notebooks whose owner turned on ' +
        'Allow AI Access, and only the notes filed directly in them. Notes are Markdown. ' +
        'Edits apply directly; Devot keeps the text from before each edit in the note history, ' +
        'and trashed notes stay in the Trash until the owner empties it.',
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
        'before a word or a qualifier to exclude it, and narrow with title:, body:, book:, tag:, ' +
        'status:, bookId:, tagId: or pinned:true|false (quote names with spaces: ' +
        'book:"Weekly notes"; single quotes work too). ' +
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
    run('read_note', async (ai, { id }: { id: string }) => noteJson(await ai.read(id))),
  )

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'Lists the tags on notes in notebooks that allow AI access, by name, with how many ' +
        'of those notes carry each.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    run('list_tags', async (ai) => ({ tags: await ai.tags() })),
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

  server.registerTool(
    'update_note',
    {
      title: 'Update a note',
      description:
        'Changes a note in a notebook that allows AI access. Pass only what changes: title; the ' +
        'body as either markdown (the whole new body) or patches (exact passages to replace, ' +
        'applied in order; each find text must occur exactly once); notebook (ID or exact name ' +
        'of a notebook that allows AI access); tags (the complete new list of tag names; new ' +
        'names become tags); status. The text from before the edit is kept in the note ' +
        'history. Returns the note as read_note would.',
      inputSchema: {
        id: NOTE_ID.describe('The note ID'),
        title: z
          .string()
          .max(MAX_TITLE_CHARS * 4)
          .optional()
          .describe('One line'),
        markdown: z.string().optional().describe('The whole new body, in Markdown'),
        patches: z
          .array(
            z.object({
              find: z.string().min(1).describe('Text in the body, exactly as read_note shows it'),
              replace: z.string().describe('What replaces it'),
            }),
          )
          .min(1)
          .max(MAX_AI_PATCHES)
          .optional()
          .describe('Passages to replace, instead of markdown'),
        notebook: z.string().min(1).max(500).optional().describe('A notebook ID or exact name'),
        tags: z
          .array(z.string().max(MAX_TAG_NAME_CHARS * 4))
          .max(MAX_AI_TAGS)
          .optional()
          .describe('All tag names the note should have ([] removes every tag)'),
        status: z.enum(NOTE_STATUSES).optional(),
      },
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
    },
    run('update_note', async (ai, args: UpdateArgs) => {
      const note = await ai.update(toUpdate(args))
      log('I_MCP_NOTE_UPDATED', note.id)
      return noteJson(note)
    }),
  )

  server.registerTool(
    'trash_note',
    {
      title: 'Move a note to the Trash',
      description:
        'Moves a note in a notebook that allows AI access to the Trash. It is not deleted: ' +
        'the owner can restore it from the Trash in Devot.',
      inputSchema: { id: NOTE_ID.describe('The note ID') },
      annotations: { ...WRITES, destructiveHint: true, idempotentHint: false },
    },
    run('trash_note', async (ai, { id }: { id: string }) => {
      const trashed = await ai.trash(id)
      log('I_MCP_NOTE_TRASHED', trashed.id)
      return { ...trashed, trashed: true }
    }),
  )

  server.registerTool(
    'create_notebook',
    {
      title: 'Create a notebook',
      description:
        'Creates a notebook with Allow AI Access on, at the top level or inside a notebook ' +
        'that allows AI access (parent: ID or exact name). Returns its ID.',
      inputSchema: {
        name: z
          .string()
          .max(MAX_BOOK_NAME_CHARS * 4)
          .describe('One line'),
        parent: z.string().min(1).max(500).optional().describe('A notebook ID or exact name'),
      },
      annotations: { ...WRITES, destructiveHint: false, idempotentHint: false },
    },
    run('create_notebook', async (ai, input: { name: string; parent?: string | undefined }) => {
      const created = await ai.createNotebook(
        input.parent === undefined
          ? { name: input.name }
          : { name: input.name, parent: input.parent },
      )
      log('I_MCP_NOTEBOOK_CREATED', created.id)
      return created
    }),
  )

  return server
}
