import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { cssRules } from '../support/css-rules'

const rules = cssRules(readFileSync('src/renderer/src/app.css', 'utf8'))
const find = (selector: string) =>
  rules.filter(
    (r) => r.selector === selector || r.selector.split(',').some((s) => s.trim() === selector),
  )
const declares = (selector: string, property: string) =>
  find(selector).some((r) => r.body.has(property))

it('buttons show hover and press, and a disabled one ignores the pointer', () => {
  for (const state of ['hover', 'active']) {
    expect(declares(`.button:${state}:not(:disabled, [aria-disabled='true'])`, 'background')).toBe(
      true,
    )
    expect(
      declares(`.button-default:${state}:not(:disabled, [aria-disabled='true'])`, 'background'),
    ).toBe(true)
  }
  expect(find('.button:disabled')[0]?.body.get('pointer-events')).toBe('none')
  expect(find('.tool:disabled')[0]?.body.get('pointer-events')).toBe('none')
})

it('buttons, fields and the switch fade between states', () => {
  const faded = rules
    .filter((r) => r.body.get('transition')?.includes('--motion-duration-'))
    .map((r) => r.selector)
    .join(' ')
  for (const name of [
    '.button',
    '.search-field',
    '.find-field',
    '.link-dialog-field',
    '.settings-number',
    '.tag-input',
  ]) {
    expect(faded.includes(name)).toBe(true)
  }
  expect(faded).toContain(".setting-toggle input[role='switch']")
})

it('the keyboard focus on a field or a button shows a ring or a focus-coloured edge', () => {
  expect(
    declares(':is(.tool, .button, .popup, .segment, .search-clear):focus-visible', 'outline'),
  ).toBe(true)
  expect(find('.search-field:focus-within')[0]?.body.get('box-shadow')).toContain(
    '--color-focus-ring',
  )
  expect(find('.settings-number:focus')[0]?.body.get('border-color')).toBe(
    'var(--color-focus-ring)',
  )
})
