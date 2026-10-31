import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uiSelection } from './ui-selection'

const root = resolve(import.meta.dirname, '../..')
const editor = 'tests/ui/editor-settings.spec.ts'
const csp = 'tests/ui-csp/csp.spec.ts'

describe('uiSelection', () => {
  it('defaults to both complete projects', () => {
    expect(uiSelection(root, {})).toEqual({ projects: ['webkit', 'webkit-prod-csp'] })
  })

  it.each(['webkit', 'webkit-prod-csp'] as const)(
    'selects the complete %s project for an empty file list',
    (project) => {
      expect(uiSelection(root, { DEVOT_UI_PROJECT: project, DEVOT_UI_TEST_FILES: '[]' })).toEqual({
        projects: [project],
      })
    },
  )

  it('matches only the exact absolute spec paths', () => {
    const selection = uiSelection(root, {
      DEVOT_UI_PROJECT: 'webkit',
      DEVOT_UI_TEST_FILES: JSON.stringify([editor]),
    })
    const matcher = selection.testMatch!
    expect(matcher.test(`${root}/${editor}`)).toBe(true)
    expect(matcher.test(`${root}/${editor.replace('.spec.ts', 'Xspec.ts')}`)).toBe(false)
    expect(matcher.test(`${root}/nested/${editor}`)).toBe(false)
    expect(matcher.test(`${root}/${editor}.extra`)).toBe(false)
  })

  it('accepts CSP specs only for their project', () => {
    expect(
      uiSelection(root, {
        DEVOT_UI_PROJECT: 'webkit-prod-csp',
        DEVOT_UI_TEST_FILES: JSON.stringify([csp]),
      }).testMatch?.test(`${root}/${csp}`),
    ).toBe(true)
  })

  it.each([
    { DEVOT_UI_PROJECT: '' },
    { DEVOT_UI_PROJECT: 'chromium' },
    { DEVOT_UI_TEST_FILES: '[]' },
    { DEVOT_UI_PROJECT: 'webkit', DEVOT_UI_TEST_FILES: '' },
    { DEVOT_UI_PROJECT: 'webkit', DEVOT_UI_TEST_FILES: '{}' },
    { DEVOT_UI_PROJECT: 'webkit', DEVOT_UI_TEST_FILES: '[1]' },
    ...[
      '/tests/ui/editor-settings.spec.ts',
      'tests/ui/../ui/editor-settings.spec.ts',
      'tests/ui/missing.spec.ts',
      'tests/ui/*.spec.ts',
      csp,
    ].map((file) => ({ DEVOT_UI_PROJECT: 'webkit', DEVOT_UI_TEST_FILES: JSON.stringify([file]) })),
  ])('rejects invalid selection %j', (env) => {
    expect(() => uiSelection(root, env)).toThrow(/DEVOT_UI_/)
  })
})
