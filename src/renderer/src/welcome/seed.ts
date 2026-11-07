import type { ListedLibrary } from '../../../core'
import { holdsNothing } from '../../../core/libraryLists'
import { errorCode } from '../../../core/errors'

/**
 * The library's lists at start, with the first-launch notes seeded (`seed`) only into a library the lists show has never held anything (core/welcome.ts), then listed again.
 * Storage checks again as it seeds, so lists that look empty but are not stay as they are; every later start lists once and never seeds.
 */
export async function listSeeded<T extends ListedLibrary>(
  list: () => Promise<T>,
  seed?: () => Promise<string | null>,
): Promise<T> {
  const listed = await list()
  if (!seed || !holdsNothing(listed)) return listed
  const seeded = await seed().catch((e: unknown) => {
    console.warn('W_WELCOME_FAILED', errorCode(e))
    return null
  })
  return seeded === null ? listed : list()
}
