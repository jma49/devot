import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const UI_ROOT = 'src/renderer/src'
const RING = 'var(--size-focus-ring) solid var(--color-focus-ring)'
const OFFSETS = new Set(['0', 'calc(-1 * var(--size-focus-ring))', 'var(--size-focus-ring)'])
const DROP = 'var(--size-drop-indicator) dashed var(--color-accent-fill)'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function offenders(css: string): string[] {
  return cssRules(css).flatMap(({ selector, body }) => {
    const outline = body.get('outline')
    if (outline === undefined || outline === 'none' || outline === '0' || outline === DROP)
      return []
    const offset = body.get('outline-offset') ?? '0'
    return outline === RING && OFFSETS.has(offset) ? [] : [`${selector} { outline: ${outline} }`]
  })
}

it('draws every focus ring from the focus ring tokens', () => {
  const css = files(UI_ROOT).filter((f) => f.endsWith('.css') && !f.endsWith('tokens.css'))
  expect(css.flatMap((f) => offenders(readFileSync(f, 'utf8')))).toEqual([])
})

it('the focus ring check catches other rings and leaves the token ring alone', () => {
  expect(offenders('.a:focus-visible { outline: 2px solid var(--color-accent-fill); }')).toEqual([
    '.a:focus-visible { outline: 2px solid var(--color-accent-fill) }',
  ])
  expect(offenders(`.a:focus-visible { outline: ${RING}; outline-offset: 3px; }`)).toHaveLength(1)
  expect(
    offenders(
      `.a:focus-visible { outline: ${RING}; }\n.b { outline: none; }\n.c:focus { outline: ${RING}; outline-offset: calc(-1 * var(--size-focus-ring)); }`,
    ),
  ).toEqual([])
})

it('no UI code paints an outline in the accent colour', () => {
  const ts = files(UI_ROOT).filter((f) => /\.tsx?$/.test(f) && !f.includes('/theme/tokens'))
  const found = ts.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((line) => /outline\w*:.*--color-accent/.test(line))
      .map((line) => `${f}: ${line.trim()}`),
  )
  expect(found).toEqual([])
})
