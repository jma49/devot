import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listFiles } from '../support/git-files'
import { hasColorLiteral, isColorChecked, isColorExempt } from '../support/policy-patterns'

// UI colours come only from generated tokens; CodeMirror themes live in .ts files, so TypeScript is scanned too.
const UI_ROOT = 'src/renderer/src'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

// The plugin frame and the HTML pages paint before the UI's styles load, so they are scanned too.
const pages = () => [
  ...listFiles('.', 'src-tauri/plugin-frame'),
  ...listFiles('.', 'src/renderer').filter((file) => /^src\/renderer\/[^/]+\.html$/.test(file)),
]

it('UI styles use design tokens, not colour literals', () => {
  const scanned = [...files(UI_ROOT).filter(isColorChecked), ...pages()]
  expect(scanned).toEqual(
    expect.arrayContaining(['src-tauri/plugin-frame/runtime.js', 'src/renderer/index.html']),
  )
  const offenders = scanned.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        hasColorLiteral(line) && !isColorExempt(file, line)
          ? [`${file}:${i + 1}: ${line.trim()}`]
          : [],
      ),
  )
  expect(offenders).toEqual([])
})

it("only the Mermaid pie's mask luminance is exempt, by name", () => {
  const theme = 'src/renderer/src/preview/mermaid-theme.ts'
  expect(isColorExempt(theme, "const MASK_KEEP = 'white'")).toBe(true)
  expect(isColorExempt(theme, "const MASK_CUT = 'black'")).toBe(true)
  expect(isColorExempt(theme, "kept.setAttribute('fill', 'white')")).toBe(false)
  expect(isColorExempt('src/renderer/src/Other.tsx', "const MASK_KEEP = 'white'")).toBe(false)
  expect(readFileSync(theme, 'utf8')).toContain("setAttribute('fill', MASK_KEEP)")
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
    "{ color: 'orange' }",
    'border-color: Purple;',
    "{ fill: 'yellow' }",
    "{ color: 'pink' }",
    "{ color: 'lightgray' }",
    "{ stroke: 'darkblue' }",
    '<rect fill="white" />',
    "<path stroke='black' />",
    "<circle fill={'orange'} />",
    '<stop stop-color="purple" />',
    "rect.setAttribute('fill', 'white')",
    'path.setAttribute("stroke", "teal")',
    "el.style.color = 'red'",
    "el.style.setProperty('--accent', 'gold')",
  ]
  const tokens = [
    "{ color: 'var(--text)' }",
    "'.cm-line': { background: 'var(--surface-raised)' }",
    "const label = 'Mark red as done'",
    "'tagColor.red': 'Red',",
    'color: var(--accent);',
    "const x = this.#cache.get('k')",
    "{ status: 'shared' }",
    "{ state: 'ordered' }",
    '<rect fill="none" stroke="currentColor" />',
    "rect.setAttribute('fill', 'var(--accent)')",
    "rect.setAttribute('class', 'white')",
    "el.style.color = 'var(--text)'",
    "const name = 'Orange'",
    '<meta name="color-scheme" content="light dark" />',
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
