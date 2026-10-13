import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { hasColorLiteral, isColorChecked } from '../support/policy-patterns'

// UI colours come only from the generated design tokens. Hex, rgb(), hsl()
// and named colours are rejected in UI styles, components and TypeScript
// (CodeMirror themes live in .ts files).
const UI_ROOT = 'src/renderer/src'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

it('UI styles use design tokens, not colour literals', () => {
  const offenders = files(UI_ROOT)
    .filter(isColorChecked)
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (hasColorLiteral(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    )
  expect(offenders).toEqual([])
})

it('the scan covers CSS, TSX and TS but not the generated tokens or tests', () => {
  const checked = [
    `${UI_ROOT}/a.css`,
    `${UI_ROOT}/a.tsx`,
    `${UI_ROOT}/editor/theme.ts`,
    `${UI_ROOT}/theme/other.ts`,
  ]
  const skipped = [
    `${UI_ROOT}/theme/tokens.css`,
    `${UI_ROOT}/theme/tokens.ts`,
    `${UI_ROOT}/editor/theme.test.ts`,
    `${UI_ROOT}/App.test.tsx`,
    `${UI_ROOT}/logo.svg`,
  ]
  expect(checked.filter((path) => !isColorChecked(path))).toEqual([])
  expect(skipped.filter(isColorChecked)).toEqual([])
})

it('the colour pattern catches literals in TypeScript and leaves tokens alone', () => {
  const literals = [
    "const accent = '#3a7bd5'",
    "{ color: 'red' }",
    'background: "white"',
    "'.cm-line': { color: rgb(1, 2, 3) }",
    'fill: hsl(10 20% 30%)',
    'color: black;',
    'color: RED;',
    'background: White',
    "{ background: '#fff8' }",
  ]
  const tokens = [
    "{ color: 'var(--text)' }",
    "'.cm-line': { background: 'var(--surface-raised)' }",
    "const label = 'Mark red as done'",
    "'tagColor.red': 'Red',",
    'color: var(--accent);',
    "const x = this.#cache.get('k')",
  ]
  expect(literals.filter((line) => !hasColorLiteral(line))).toEqual([])
  expect(tokens.filter(hasColorLiteral)).toEqual([])
})

it("the editor does not use CodeMirror's default highlight style, which has light-only colours", () => {
  const offenders = files(UI_ROOT)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.test.ts'))
    .filter((file) => /\bdefaultHighlightStyle\b/.test(readFileSync(file, 'utf8')))
  expect(offenders).toEqual([])
})
