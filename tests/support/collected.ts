import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

setFlagsFromString('--expose_gc')
const gc = runInNewContext('gc') as () => void

/**
 * Whether nothing holds what `refs` point to once garbage is collected.
 * A WeakRef keeps its target until the turn that made it ends, so this waits a turn first.
 */
export async function collected(refs: readonly WeakRef<object>[]): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  gc()
  return refs.every((ref) => ref.deref() === undefined)
}
