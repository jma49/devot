import { execFileSync } from 'node:child_process'

/**
 * Hooks (pre-push) export GIT_DIR, GIT_INDEX_FILE and friends; inherited, they would send a scratch
 * repository's init, config and commits into the real one.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

export function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() })
}

/** NUL-separated with quoting off, so non-ASCII names come back as written. */
export function listFiles(cwd: string, ...paths: string[]): string[] {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=off', 'ls-files', '-z', '-co', '--exclude-standard', ...paths],
    { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 },
  )
  return out.split('\0').filter(Boolean)
}
