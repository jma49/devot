import { statSync } from 'node:fs'
import { resolve } from 'node:path'

type UiProject = 'webkit' | 'webkit-prod-csp'
type Selection = { projects: UiProject[]; testMatch?: RegExp }

export function uiSelection(root: string, env: Record<string, string | undefined>): Selection {
  const project = env['DEVOT_UI_PROJECT']
  const encodedFiles = env['DEVOT_UI_TEST_FILES']
  if (project === undefined) {
    if (encodedFiles !== undefined) throw new Error('DEVOT_UI_TEST_FILES requires DEVOT_UI_PROJECT')
    return { projects: ['webkit', 'webkit-prod-csp'] }
  }
  if (project !== 'webkit' && project !== 'webkit-prod-csp') {
    throw new Error('Invalid DEVOT_UI_PROJECT')
  }
  const selection: Selection = { projects: [project] }
  if (encodedFiles === undefined) return selection
  let files: unknown
  try {
    files = JSON.parse(encodedFiles)
  } catch {
    throw new Error('DEVOT_UI_TEST_FILES must be a JSON array of spec paths')
  }
  if (!Array.isArray(files))
    throw new Error('DEVOT_UI_TEST_FILES must be a JSON array of spec paths')
  const directory = project === 'webkit' ? 'tests/ui/' : 'tests/ui-csp/'
  const paths = files.map((file: unknown) => {
    if (
      typeof file !== 'string' ||
      !file.startsWith(directory) ||
      !file.endsWith('.spec.ts') ||
      file.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      file.includes('\\')
    ) {
      throw new Error('DEVOT_UI_TEST_FILES contains an invalid spec path')
    }
    const absolute = resolve(root, file)
    if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('DEVOT_UI_TEST_FILES contains a missing spec path')
    }
    return absolute.replaceAll('\\', '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  if (paths.length > 0) selection.testMatch = new RegExp(`^(?:${paths.join('|')})$`)
  return selection
}
