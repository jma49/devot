// The main window's half of `devot append`: Rust sends each request as an event and waits for
// `cli_append_done` (src-tauri/src/cli_append.rs). Requests run one at a time, each claimed first
// (`cli_append_claim`): one Rust gave up on before the claim never runs, one it gives up on after
// still lands (`E_CLI_APPEND_LATE`). The answer is a code or nothing, never the text.
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
  | { readonly kind: 'today' }

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
  if (kind === 'today') return { kind }
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

/** The note a request names: by ID as given, by title among the live notes (findNoteByTitle), or today's note, made first when missing. */
export async function resolveAppendTarget(
  target: CliAppendTarget,
  list: () => Promise<readonly TitledNote[]>,
  today: () => Promise<string>,
): Promise<string> {
  if (target.kind === 'id') return target.id
  if (target.kind === 'today') return today()
  return findNoteByTitle(await list(), target.title)
}

export interface CliAppendHost {
  /** Rejects once Rust has given up on the request, which then never runs. */
  claim: (id: number) => Promise<unknown>
  run: (request: CliAppendRequest) => Promise<void>
  reply: (id: number, error: string | null) => Promise<unknown>
}

/** Takes each event payload; one that is not a request is ignored. Resolves once the queue is empty. */
export function cliAppendHost({ claim, run, reply }: CliAppendHost) {
  let queue: Promise<void> = Promise.resolve()
  return (payload: unknown): Promise<void> => {
    const request = readCliAppendRequest(payload)
    if (!request) {
      console.warn('W_CLI_APPEND_INVALID')
      return queue
    }
    queue = queue.then(async () => {
      try {
        await claim(request.id)
      } catch (e) {
        console.warn('W_CLI_APPEND_CLAIM_FAILED', errorCode(e))
        return
      }
      let error: string | null = null
      try {
        await run(request)
      } catch (e) {
        error = errorCode(e, 'E_CLI_APPEND_FAILED')
      }
      try {
        await reply(request.id, error)
      } catch (e) {
        // Rust gave up waiting after the claim (the command got E_CLI_APPEND_LATE).
        console.warn('W_CLI_APPEND_ANSWER_FAILED', errorCode(e))
      }
    })
    return queue
  }
}
