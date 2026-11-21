import { statSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The exact Vitest files a CI shard runs, from DEVOT_TEST_FILES (a JSON array of paths from the
 * repository root), or undefined to run every test. An empty array also runs every test.
 */
export function testSelection(
  root: string,
  env: Record<string, string | undefined>,
): string[] | undefined {
  const encoded = env['DEVOT_TEST_FILES']
  if (encoded === undefined) return undefined
  let files: unknown
  try {
    files = JSON.parse(encoded)
  } catch {
    throw new Error('E_TEST_FILES_NOT_JSON')
  }
  if (!Array.isArray(files)) throw new Error('E_TEST_FILES_NOT_ARRAY')
  if (!files.length) return undefined
  return files.map((file: unknown) => {
    if (
      typeof file !== 'string' ||
      !/\.test\.tsx?$/.test(file) ||
      file.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      /[\\*?[\]{}()!]/.test(file)
    ) {
      throw new Error(`E_TEST_FILES_INVALID ${String(file)}`)
    }
    if (!statSync(resolve(root, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`E_TEST_FILES_MISSING ${file}`)
    }
    return file
  })
}
