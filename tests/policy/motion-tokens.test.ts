import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { isColorChecked } from '../support/policy-patterns'

// Motion comes from `--motion-*` tokens, never literals; Reduce Motion turns every scale off (pop-ups only fade).
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

it('things grow and shrink only through the scale variables, which Reduce Motion sets to 1', () => {
  const scales = files(UI_ROOT)
    .filter(isColorChecked)
    .flatMap((file) => readFileSync(file, 'utf8').match(/(?<![\w-])scale[:(][^;\n]*/g) ?? [])
  expect(scales.length).toBeGreaterThan(0)
  expect(
    // At rest a thing is at its own size (`scale: 1`).
    scales.filter(
      (s) => !/var\(--(popover-(enter|exit)|dialog-enter|chip-enter)-scale\)|^scale: 1$/.test(s),
    ),
  ).toEqual([])

  const css = readFileSync(`${UI_ROOT}/app.css`, 'utf8')
  expect(css).toMatch(/--popover-enter-scale:\s*var\(--motion-scale-popover-enter\)/)
  expect(css).toMatch(/--popover-exit-scale:\s*var\(--motion-scale-popover-exit\)/)
  expect(css).toMatch(/--dialog-enter-scale:\s*var\(--motion-scale-dialog-enter\)/)
  expect(css).toMatch(/--chip-enter-scale:\s*var\(--motion-scale-chip-enter\)/)
  // Reduce Motion is the root's `data-motion` (motionPreference.ts), never the media query alone.
  expect(css).not.toMatch(/prefers-reduced-motion/)
  const reduced = css.split(":root[data-motion='reduced']").slice(1).join('')
  expect(reduced).toMatch(/--popover-enter-scale:\s*1;/)
  expect(reduced).toMatch(/--popover-exit-scale:\s*1;/)
  expect(reduced).toMatch(/--dialog-enter-scale:\s*1;/)
  expect(reduced).toMatch(/--chip-enter-scale:\s*1;/)
})
