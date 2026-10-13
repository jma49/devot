import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isColorChecked } from '../support/policy-patterns'

// Motion comes from the design tokens too: durations, easing curves and the
// scale a pop-up grows from are `--motion-*` tokens, never literals, and Reduce
// Motion turns every scale off (pop-ups only fade).
const UI_ROOT = 'src/renderer/src'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

const EASING = /\bease(-in|-out|-in-out)?\b|cubic-bezier\(/
const TIME = /(?<![\w.-])(?!0m?s\b)\d*\.?\d+m?s\b/
const MOTION = /\b(transition|animation)/

/** A line that writes a duration or easing curve as a literal. */
function hasMotionLiteral(line: string): boolean {
  const code = line.replace(/\/\*.*?\*\/|\/\/.*$/g, '')
  return (
    EASING.test(code) || (MOTION.test(code) && TIME.test(code)) || /--\S*motion\S*:\s*\d/.test(code)
  )
}

it('UI motion uses design tokens, not literal durations or curves', () => {
  const offenders = files(UI_ROOT)
    .filter(isColorChecked)
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (hasMotionLiteral(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    )
  expect(offenders).toEqual([])
})

it('the motion pattern catches literals and leaves tokens alone', () => {
  const literals = [
    "animation: 'cm-codeblock-copy-in 0.2s ease-out',",
    '  transition: color 400ms var(--motion-easing-standard);',
    '    width var(--pane-motion) ease-in-out,',
    "transition: 'opacity var(--motion-duration-fade) cubic-bezier(0.2, 0, 0, 1)'",
    '  --pane-motion: 220ms;',
  ]
  const tokens = [
    'transition: color var(--motion-duration-color) var(--motion-easing-standard);',
    '    visibility 0s linear var(--pane-motion);',
    'transition: none;',
    'const SHOW_AFTER_MS = 500 // milliseconds, ease the pointer in',
  ]
  expect(literals.filter((line) => !hasMotionLiteral(line))).toEqual([])
  expect(tokens.filter(hasMotionLiteral)).toEqual([])
})

it('pop-ups grow only through the scale variable, which Reduce Motion sets to 1', () => {
  const scales = files(UI_ROOT)
    .filter(isColorChecked)
    .flatMap((file) => readFileSync(file, 'utf8').match(/(?<![\w-])scale[:(][^;\n]*/g) ?? [])
  expect(scales.length).toBeGreaterThan(0)
  expect(scales.filter((s) => !s.includes('var(--popover-enter-scale)'))).toEqual([])

  const css = readFileSync(`${UI_ROOT}/app.css`, 'utf8')
  expect(css).toMatch(/--popover-enter-scale:\s*var\(--motion-scale-popover-enter\)/)
  const reduced = css.split('@media (prefers-reduced-motion: reduce)').slice(1).join('')
  expect(reduced).toMatch(/--popover-enter-scale:\s*1;/)
})
