import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { TEMP_FOLDER_REFERENCE } from '../support/policy-patterns'

// Tests make temporary folders only through tempDir (tests/support/temp-dirs.ts),
// which removes them when the test file ends; anything made in the system temp
// folder any other way (a folder, or a file such as a SQLite database written
// straight into it) stays there after every run. So nothing else names the
// system temp folder at all.
it('no test uses the system temp folder except through tempDir', () => {
  const files = listFiles('.', 'tests', 'src').filter(
    (f) =>
      /\.(ts|tsx)$/.test(f) &&
      f !== 'tests/support/temp-dirs.ts' &&
      f !== 'tests/policy/temp-dirs.test.ts',
  )
  const offenders = files.filter((file) => TEMP_FOLDER_REFERENCE.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('the temp-folder check catches a file written straight into the temp folder', () => {
  const pattern = TEMP_FOLDER_REFERENCE
  expect(pattern.test("writeFileSync(join(tmpdir(), 'x.sqlite'), '')")).toBe(true)
  expect(pattern.test("import { tmpdir } from 'node:os'")).toBe(true)
  expect(pattern.test("join(tempDir('devot-x-'), 'x.sqlite')")).toBe(false)
})

it('no Rust code makes a folder under env::temp_dir() by hand', () => {
  const files = listFiles('.', 'src-tauri').filter((f) => f.endsWith('.rs'))
  const offenders = files.filter((file) => /env::temp_dir\(\)/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
