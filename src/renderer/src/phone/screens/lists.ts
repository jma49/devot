import type { BatchChange, BatchResult } from '../../../../core/batch'
import type { ScreensHandlers } from './ops'

/** What the native lists ask of the core (docs/specs/iphone-screens.md, Operations). */
export interface ListsCore {
  readonly excerpts: (ids: string[]) => Promise<Record<string, string>>
  readonly batch: (ids: string[], change: BatchChange) => Promise<BatchResult>
  readonly emptyTrash: () => Promise<number>
  readonly createTemplate: () => Promise<string>
  readonly applyTemplate: (id: string, now: number, bookId: string | null) => Promise<string>
  readonly read: (id: string) => Promise<{ title: string; bodyMd: string }>
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const idOrNone = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Rust has checked every argument (`screens::message`); the core checks them again. */
export function listHandlers(
  core: () => ListsCore | null,
  now: () => number = Date.now,
): ScreensHandlers {
  const started = () => {
    const found = core()
    if (!found) throw new Error('E_SCREENS_UNAVAILABLE')
    return found
  }
  return {
    excerpts: async (args) => ({
      excerpts: await started().excerpts(strings(args['ids'])),
    }),
    'notes.batch': async (args) =>
      started().batch(strings(args['ids']), args['change'] as BatchChange),
    'trash.empty': async () => ({ purged: await started().emptyTrash() }),
    'template.create': async () => ({ id: await started().createTemplate() }),
    'template.apply': async (args) => ({
      id: await started().applyTemplate(
        String(args['templateId']),
        now(),
        idOrNone(args['bookId']),
      ),
    }),
    'note.text': async (args) => {
      const note = await started().read(String(args['noteId']))
      return { title: note.title, markdown: note.bodyMd }
    },
  }
}
