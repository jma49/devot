import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitIn, listFiles } from './git-files'
import { tempDir } from './temp-dirs'

const saved = { GIT_DIR: process.env['GIT_DIR'], GIT_INDEX_FILE: process.env['GIT_INDEX_FILE'] }

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

it('works on the scratch repository even when a git hook points git elsewhere', () => {
  // A hook (pre-push runs the tests) exports GIT_DIR and GIT_INDEX_FILE for
  // the repository being pushed; a decoy stands in for it here.
  const decoy = tempDir('devot-git-decoy-')
  gitIn(decoy, 'init', '-q')
  const decoyConfig = readFileSync(join(decoy, '.git/config'), 'utf8')
  process.env['GIT_DIR'] = join(decoy, '.git')
  process.env['GIT_INDEX_FILE'] = join(decoy, '.git/index')

  const repo = tempDir('devot-git-scratch-')
  gitIn(repo, 'init', '-q')
  gitIn(repo, 'config', 'user.email', 'ci@example.invalid')
  gitIn(repo, 'config', 'user.name', 'ci')
  writeFileSync(join(repo, 'a.txt'), 'x')
  expect(listFiles(repo)).toEqual(['a.txt'])
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-q', '-m', 'scratch')

  expect(gitIn(repo, 'log', '--format=%s').trim()).toBe('scratch')
  expect(readFileSync(join(decoy, '.git/config'), 'utf8')).toBe(decoyConfig)
  expect(gitIn(decoy, 'rev-list', '--all')).toBe('')
})
