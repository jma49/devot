import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// scripts/stack/restack.sh against a temporary clone with a local bare
// repository as origin: after the bottom layer is squash-merged, the layers
// above it keep only their own commits, on top of main.

const SCRIPT = join(import.meta.dirname, '../../scripts/stack/restack.sh')
const PROCESSES = { timeout: 30_000 }

/** Without the GIT_* variables a git hook sets for the repository it runs in:
 *  they would point these commands at that repository. */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  return {
    ...env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), `${message}\n`)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-m', message)
}

/** A clone whose origin has `main` plus a stack of layers, each branched
 *  from the one below and holding one commit. Layer 1 is then squash-merged. */
function stackedRepo(layers: number) {
  const origin = join(tempDir('restack-origin-'), 'origin.git')
  git(tempDir('restack-init-'), 'init', '--bare', '-b', 'main', origin)
  const work = tempDir('restack-work-')
  git(work, 'init', '-b', 'main')
  git(work, 'remote', 'add', 'origin', origin)
  commit(work, 'base.txt', 'base')
  git(work, 'push', '-u', 'origin', 'main')

  const names: string[] = []
  for (let i = 1; i <= layers; i++) {
    const name = `layer${i}`
    git(work, 'checkout', '-b', name)
    commit(work, `${name}.txt`, name)
    git(work, 'push', 'origin', name)
    names.push(name)
  }
  const oldTip = git(work, 'rev-parse', 'layer1')

  git(work, 'checkout', 'main')
  git(work, 'merge', '--squash', 'layer1')
  git(work, 'commit', '-m', 'layer1 squashed')
  git(work, 'push', 'origin', 'main')
  git(work, 'push', 'origin', '--delete', 'layer1')
  return { work, names, oldTip }
}

function restack(work: string, oldTip: string, ...branches: string[]) {
  return spawnSync('bash', [SCRIPT, '--old-tip', oldTip, ...branches], {
    cwd: work,
    encoding: 'utf8',
    env: gitEnv({ DEVOT_RESTACK_NO_GH: '1' }),
  })
}

const subjects = (cwd: string, range: string) =>
  git(cwd, 'log', '--format=%s', range).split('\n').filter(Boolean)

describe('restack.sh', () => {
  it('moves a second layer onto main without the squashed commit', PROCESSES, () => {
    const { work, oldTip } = stackedRepo(2)
    const result = restack(work, oldTip, 'layer1', 'layer2')
    expect(result.status).toBe(0)
    expect(subjects(work, 'origin/main..layer2')).toEqual(['layer2'])
    expect(git(work, 'rev-parse', 'origin/layer2')).toBe(git(work, 'rev-parse', 'layer2'))
  })

  it('restacks a third layer on its rebased parent', PROCESSES, () => {
    const { work, oldTip } = stackedRepo(3)
    const result = restack(work, oldTip, 'layer1', 'layer2', 'layer3')
    expect(result.status).toBe(0)
    expect(subjects(work, 'origin/main..layer2')).toEqual(['layer2'])
    expect(subjects(work, 'origin/main..layer3')).toEqual(['layer3', 'layer2'])
    expect(git(work, 'rev-parse', 'origin/layer3')).toBe(git(work, 'rev-parse', 'layer3'))
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('refuses a dirty worktree', PROCESSES, () => {
    const { work, oldTip } = stackedRepo(2)
    writeFileSync(join(work, 'stray.txt'), 'x')
    const result = restack(work, oldTip, 'layer1', 'layer2')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not clean')
  })

  it('prints the commands and changes nothing with --dry-run', PROCESSES, () => {
    const { work, oldTip } = stackedRepo(2)
    const before = git(work, 'rev-parse', 'layer2')
    const result = spawnSync(
      'bash',
      [SCRIPT, '--dry-run', '--old-tip', oldTip, 'layer1', 'layer2'],
      { cwd: work, encoding: 'utf8', env: gitEnv({ DEVOT_RESTACK_NO_GH: '1' }) },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`git rebase --onto origin/main ${oldTip} layer2`)
    expect(result.stdout).toContain('--force-with-lease origin layer2')
    expect(git(work, 'rev-parse', 'layer2')).toBe(before)
  })

  it('stops with exit 1 and leaves the rebase in progress on a conflict', PROCESSES, () => {
    const { work, oldTip } = stackedRepo(2)
    git(work, 'checkout', 'main')
    writeFileSync(join(work, 'layer2.txt'), 'conflicting\n')
    git(work, 'add', 'layer2.txt')
    git(work, 'commit', '-m', 'conflict on main')
    git(work, 'push', 'origin', 'main')
    const result = restack(work, oldTip, 'layer1', 'layer2')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('conflict')
    expect(git(work, 'status', '--porcelain=v1', '--branch')).toContain('layer2')
  })
})
