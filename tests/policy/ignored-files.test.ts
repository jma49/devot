import { expect, it } from 'vitest'
import { gitIn } from '../support/git-files'

it('no tracked file matches an ignore pattern', () => {
  // A tracked report or screenshot is committed again by the next `git add -A`, with its local paths.
  const tracked = gitIn(
    process.cwd(),
    '-c',
    'core.quotepath=off',
    'ls-files',
    '-ci',
    '--exclude-standard',
  )
  expect(tracked.split('\n').filter(Boolean)).toEqual([])
})
