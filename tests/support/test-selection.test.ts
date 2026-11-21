import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { testSelection } from './test-selection'

const root = resolve(import.meta.dirname, '../..')
const file = 'tests/support/test-selection.test.ts'

it('runs every test without a selection or with an empty one', () => {
  expect(testSelection(root, {})).toBeUndefined()
  expect(testSelection(root, { DEVOT_TEST_FILES: '[]' })).toBeUndefined()
})

it('selects the exact files it is given', () => {
  expect(testSelection(root, { DEVOT_TEST_FILES: JSON.stringify([file]) })).toEqual([file])
})

it.each([
  ['not json', 'E_TEST_FILES_NOT_JSON'],
  ['{"a":1}', 'E_TEST_FILES_NOT_ARRAY'],
  ['[1]', 'E_TEST_FILES_INVALID 1'],
  ['["tests/support/budget.ts"]', 'E_TEST_FILES_INVALID tests/support/budget.ts'],
  ['["../outside.test.ts"]', 'E_TEST_FILES_INVALID ../outside.test.ts'],
  ['["/abs/a.test.ts"]', 'E_TEST_FILES_INVALID /abs/a.test.ts'],
  ['["tests/**/*.test.ts"]', 'E_TEST_FILES_INVALID tests/**/*.test.ts'],
  ['["tests/missing.test.ts"]', 'E_TEST_FILES_MISSING tests/missing.test.ts'],
])('refuses %s', (encoded, code) => {
  expect(() => testSelection(root, { DEVOT_TEST_FILES: encoded })).toThrow(code)
})
