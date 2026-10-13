import { execFileSync } from 'node:child_process'

/**
 * The environment for a git command that must work on the repository found
 * from its folder alone. A git hook (pre-push runs the tests) exports
 * GIT_DIR, GIT_INDEX_FILE and friends; inherited, they point every git
 * command at the hook's repository, whatever folder it runs in, so a scratch
 * repository's init, config and commits would land in the real one.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
}

/** Runs git in `repo` (found from that folder alone) and returns its output. */
export function gitIn(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() })
}

/**
 * The files git tracks or would track (not ignored) under the given paths,
 * relative to `cwd`. NUL-separated with quoting off, so a name with
 * non-ASCII characters comes back as written, not as a quoted escape.
 */
export function listFiles(cwd: string, ...paths: string[]): string[] {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=off', 'ls-files', '-z', '-co', '--exclude-standard', ...paths],
    { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 },
  )
  return out.split('\0').filter(Boolean)
}
