import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { TEMP_FOLDER_REFERENCE } from '../support/policy-patterns'

// Tests make temp folders only through tempDir (tests/support/temp-dirs.ts), which removes them
// when the test file ends; anything else made in the system temp folder stays after every run.
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

it('the temp-folder check catches the temp folder written out or read from the environment', () => {
  const pattern = TEMP_FOLDER_REFERENCE
  expect(pattern.test("const SHOTS = '/tmp/devot-agents'")).toBe(true)
  expect(pattern.test('path: `/tmp/${name}.png`')).toBe(true)
  expect(pattern.test("join(process.env.TMP ?? '', 'x')")).toBe(true)
  expect(pattern.test("join(process.env['TEMP'] ?? '', 'x')")).toBe(true)
  expect(pattern.test("join(root, 'tmp', 'x')")).toBe(false)
  expect(pattern.test("'notes/tmp/x.md'")).toBe(false)
})

// Rust tests use tempfile, whose folders go when they are dropped, even when
// an assertion fails first; a folder made under env::temp_dir() by hand stays.
it('no Rust code makes a folder under env::temp_dir() by hand', () => {
  const files = listFiles('.', 'src-tauri').filter((f) => f.endsWith('.rs'))
  const offenders = files.filter((file) => /env::temp_dir\(\)/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

// keep(), into_path() and disable_cleanup() turn a tempfile folder into one that is never removed.
it('no Rust code keeps a tempfile folder past its drop', () => {
  const files = listFiles('.', 'src-tauri').filter((f) => f.endsWith('.rs'))
  const kept = /\.keep\(\)|\.disable_cleanup\(|tempdir\(\)[^;]*\.into_path\(\)/
  expect(kept.test('let path = dir.keep();')).toBe(true)
  expect(kept.test('dir.disable_cleanup(true);')).toBe(true)
  expect(kept.test('let path = tempfile::tempdir().unwrap().into_path();')).toBe(true)
  expect(kept.test('reply.send(path.map(|p| p.into_path()))')).toBe(false)
  const offenders = files.filter((file) => kept.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
