import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { undocumentedUnsafe } from '../support/policy-patterns'

// clippy::undocumented_unsafe_blocks only runs where the macOS and iOS code compiles; this
// catches a misplaced SAFETY comment on any machine first.
const NATIVE = listFiles('.', 'src-tauri/src/native/macos', 'src-tauri/src/native/ios').filter(
  (file) => file.endsWith('.rs'),
)

it('Cargo.toml denies unsafe blocks without a SAFETY comment', () => {
  const manifest = readFileSync('src-tauri/Cargo.toml', 'utf8')
  expect(manifest).toMatch(/^\[lints\.clippy\]\n(?:.*\n)*?undocumented_unsafe_blocks = "deny"$/m)
})

it('every unsafe block in the native code has a SAFETY comment where clippy reads it', () => {
  expect(NATIVE).toContain('src-tauri/src/native/macos/mod.rs')
  expect(NATIVE).toContain('src-tauri/src/native/ios/mod.rs')
  const offenders = NATIVE.flatMap((file) =>
    undocumentedUnsafe(readFileSync(file, 'utf8')).map((line) => `${file}:${line}`),
  )
  expect(offenders).toEqual([])
})

it('the check reads comments the way clippy does', () => {
  const documented = [
    '// SAFETY: a.\nlet a = unsafe { f() };',
    '// SAFETY: first line.\n// More.\nunsafe { f() }',
    '// SAFETY: a.\nlet a =\n    unsafe { f() };',
    '// SAFETY: a.\nlet [\n    a,\n    b,\n] = unsafe {\n    f()\n};',
    'if flag\n    // SAFETY: a.\n    || !unsafe { f() }\n{',
    '// SAFETY: a.\n#[allow(unused)]\nlet a = unsafe { f() };',
    '// SAFETY: a.\nunsafe impl Send for A {}',
    '// SAFETY: clippy allows a blank line.\n\nunsafe { f() }',
    'unsafe fn f() {}\nunsafe extern "C" {}\n#[unsafe(no_mangle)]',
    'assert!(!csp.contains("unsafe"));',
  ]
  const undocumented = [
    'let a = unsafe { f() };',
    '// SAFETY: for the let.\nlet class = c();\nif unsafe { f(class) } {',
    '// A comment without the word.\nunsafe { f() }',
    'unsafe impl Send for A {}',
  ]
  expect(documented.filter((source) => undocumentedUnsafe(source).length > 0)).toEqual([])
  expect(undocumented.filter((source) => undocumentedUnsafe(source).length === 0)).toEqual([])
})
