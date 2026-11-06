import type { NoteContext } from './context'
import { createEdits } from './edits'
import { createMemory } from './memory'
import { createBooks } from './notebooks'
import { createProblems } from './problems'
import { createRelay } from './relay'
import { createSaving } from './saving'
import { createVersions } from './versions'

/** The parts of one note service the calls are made of. */
export interface Kernel {
  versions: ReturnType<typeof createVersions>
  problems: ReturnType<typeof createProblems>
  relay: ReturnType<typeof createRelay>
  memory: ReturnType<typeof createMemory>
  saving: ReturnType<typeof createSaving>
  books: ReturnType<typeof createBooks>
  edits: ReturnType<typeof createEdits>
}

export function createKernel(ctx: NoteContext): Kernel {
  const versions = createVersions(ctx)
  const problems = createProblems(ctx)
  const relay = createRelay(ctx)
  const memory = createMemory(ctx, { versions, problems, relay })
  const saving = createSaving(ctx, { versions, problems, relay, memory })
  const books = createBooks(ctx.storage)
  const edits = createEdits(ctx, { versions, relay, saving })
  return { versions, problems, relay, memory, saving, books, edits }
}
