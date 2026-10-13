import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Temporary folders for tests. Every folder made here is removed when its
// test file ends (tests/support/temp-dirs.setup.ts), so test runs leave
// nothing behind in the system temp folder.

const made: string[] = []

/** A new empty folder in the system temp folder, removed after this test file. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** Removes every folder made so far in this test file. */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}
