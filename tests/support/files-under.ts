import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Every file under `root`, as `/`-separated paths relative to it, each folder's entries in name order. */
export function filesUnder(root: string, rel = ''): string[] {
  return readdirSync(join(root, rel))
    .sort()
    .flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name
      return statSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path]
    })
}
