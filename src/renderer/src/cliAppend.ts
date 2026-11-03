// The main window's half of `devot append` (issue #477): Rust reads the command's hand-off and
// sends the request here as an event (`devot://cli-append`), then waits for this window's answer
// (`cli_append_done`), so this window's core puts the text in the note and the open editor takes it
// as one undo step (src-tauri/src/cli_append.rs). Requests run one at a time; the answer is a code
// or nothing, never the text.
import {
  APPEND_POSITIONS,
  findNoteByTitle,
  type AppendPosition,
  type TitledNote,
} from '../../core/append'
import { errorCode } from '../../core/errors'
import { UUID_V7 } from '../../core/ids'

export const CLI_APPEND_EVENT = 'devot://cli-append'

export type CliAppendTarget =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'title'; readonly title: string }

export interface CliAppendRequest {
  id: number
  target: CliAppendTarget
  heading: string | null
  position: AppendPosition
  text: string
}

const isPosition = (value: unknown): value is AppendPosition =>
  typeof value === 'string' && (APPEND_POSITIONS as readonly string[]).includes(value)

function readTarget(value: unknown): CliAppendTarget | null {
  if (typeof value !== 'object' || value === null) return null
  const { kind, id, title } = value as Record<string, unknown>
  if (kind === 'id' && typeof id === 'string' && UUID_V7.test(id)) return { kind, id }
  if (kind === 'title' && typeof title === 'string' && title.trim() !== '') return { kind, title }
  return null
}

/** The event's payload as Rust sends it, or null for any other shape. */
export function readCliAppendRequest(payload: unknown): CliAppendRequest | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { id, target, heading, position, text } = payload as Record<string, unknown>
  if (!Number.isSafeInteger(id) || (id as number) < 0) return null
  const read = readTarget(target)
  if (!read || !isPosition(position) || typeof text !== 'string') return null
  if (heading !== null && typeof heading !== 'string') return null
  return { id: id as number, target: read, heading, position, text }
}

/** The note a request names: by ID as given, by title among the live notes (findNoteByTitle). */
export async function resolveAppendTarget(
  target: CliAppendTarget,
  list: () => Promise<readonly TitledNote[]>,
): Promise<string> {
  if (target.kind === 'id') return target.id
  return findNoteByTitle(await list(), target.title)
}

export interface CliAppendHost {
  run: (request: CliAppendRequest) => Promise<void>
  reply: (id: number, error: string | null) => Promise<unknown>
}

/** Takes each event payload; one that is not a request is ignored. Resolves once the queue is empty. */
export function cliAppendHost({ run, reply }: CliAppendHost) {
  let queue: Promise<void> = Promise.resolve()
  return (payload: unknown): Promise<void> => {
    const request = readCliAppendRequest(payload)
    if (!request) {
      console.warn('W_CLI_APPEND_INVALID')
      return queue
    }
    queue = queue.then(async () => {
      let error: string | null = null
      try {
        await run(request)
      } catch (e) {
        error = errorCode(e, 'E_CLI_APPEND_FAILED')
      }
      try {
        await reply(request.id, error)
      } catch (e) {
        // Rust gave up waiting (the command got a timeout); a write is made all the same.
        console.warn('W_CLI_APPEND_ANSWER_FAILED', errorCode(e))
      }
    })
    return queue
  }
}
