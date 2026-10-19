import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Rust writes every file outside its databases through one writer (src-tauri/src/atomic_file.rs):
// a new temp file of random name, never opened over an existing one. A file written by path
// elsewhere follows a link planted at that name. Only the log (logs.rs) appends to its own
// file in the app's private data folder. Tests may write as they like.

const WRITES = [
  /\bFile::create\(/,
  /\bFile::options\(\)/,
  /\bOpenOptions::new\(\)/,
  /\bfs::write\(/,
  /\bfs::copy\(/,
]

/** The files allowed to: the writer itself, and the log. */
const ALLOWED = new Set(['src-tauri/src/atomic_file.rs', 'src-tauri/src/logs.rs'])

const withoutTests = (text: string) => text.split(/#\[cfg\(test\)\]\s*mod tests \{/)[0]!

it('Rust writes files only through atomic_file', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src-tauri/src'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.rs') && !ALLOWED.has(f))
    .filter((f) => !/(^|\/)tests(\.rs|\/)/.test(f))
  const offenders = files.flatMap((file) => {
    const code = withoutTests(readFileSync(file, 'utf8'))
    return WRITES.filter((write) => write.test(code)).map((write) => `${file} ${write.source}`)
  })
  expect(offenders).toEqual([])
})

const CHANGES_BY_PATH = [
  /\bfs::create_dir\(/,
  /\bfs::remove_file\(/,
  /\bfs::remove_dir(_all)?\(/,
  /\bfs::rename\(/,
  /\bfs::hard_link\(/,
  /\bunix::fs::symlink\(/,
]

/**
 * Writers of user-chosen folders (mirror, exports, PDFs, Save Image As, diagnostics). They
 * must change those only through atomic_file's folder handles: by path, a local process
 * could swap a folder for a link between a check and the change.
 */
const USER_FOLDER_WRITERS = [
  'src-tauri/src/commands/images.rs',
  'src-tauri/src/diagnostics.rs',
  'src-tauri/src/export.rs',
  'src-tauri/src/mirror/folder.rs',
  'src-tauri/src/mirror/mod.rs',
]

it('Rust changes the folders the user chose only through folder handles', () => {
  const offenders = USER_FOLDER_WRITERS.flatMap((file) => {
    const code = withoutTests(readFileSync(file, 'utf8'))
    return CHANGES_BY_PATH.filter((change) => change.test(code)).map(
      (change) => `${file} ${change.source}`,
    )
  })
  expect(offenders).toEqual([])
})

it('Rust makes system calls on files only in atomic_file', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src-tauri/src'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.rs') && f !== 'src-tauri/src/atomic_file.rs')
  const offenders = files.filter((file) => /\brustix::/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})

it('finds a change by path where it would be one', () => {
  const code = 'fn prune(root: &Path) { let _ = std::fs::remove_dir(root.join("x")); }\n'
  expect(CHANGES_BY_PATH.some((change) => change.test(withoutTests(code)))).toBe(true)
  const made = 'fn make(p: &Path) { std::fs::create_dir_all(p).unwrap(); }\n'
  expect(CHANGES_BY_PATH.some((change) => change.test(made))).toBe(false)
})

it('finds a write by path where it would be one', () => {
  const code = 'fn save(p: &Path) { std::fs::write(p, b"x").unwrap(); }\n'
  expect(WRITES.some((write) => write.test(withoutTests(code)))).toBe(true)
  const tested =
    'fn ok() {}\n#[cfg(test)]\nmod tests {\n    fn t() { std::fs::write(p, b"x"); }\n}\n'
  expect(WRITES.some((write) => write.test(withoutTests(tested)))).toBe(false)
})
