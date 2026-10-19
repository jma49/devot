import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// The core index re-exports import, export and HTML conversion (parse5, yaml, remark): a value
// import of it from the window puts them in the startup bundle. The worker may use it.
it('the window imports only types from the core index', () => {
  const offenders = sources('src/renderer/src')
    .filter((file) => !file.endsWith('core.worker.ts'))
    .filter((file) =>
      [
        ...readFileSync(file, 'utf8').matchAll(
          /^import (type )?\{([^}]*)\} from '(?:\.\.\/)+core'$/gm,
        ),
      ].some(
        ([, typeOnly, names]) =>
          !typeOnly &&
          names!
            .split(',')
            .map((name) => name.trim())
            .some((name) => name !== '' && !name.startsWith('type ')),
      ),
    )
  expect(offenders).toEqual([])
})
