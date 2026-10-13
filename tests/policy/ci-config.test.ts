import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn } from '../support/git-files'
import { tempDir } from '../support/temp-dirs'

// The documented gate must be the real one: `pnpm check` runs what CI runs,
// CI keeps its evidence, and the local hooks cover the formatting CI checks.

const read = (path: string) => readFileSync(path, 'utf8')
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
const workflow = read('.github/workflows/ci.yml')
const lefthook = read('lefthook.yml')

/** The text of one top-level job of ci.yml. */
function job(name: string): string {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\n)*)`, 'm').exec(workflow)
  if (!match) throw new Error(`ci.yml has no job ${name}`)
  return match[1] ?? ''
}

/** The `run:` commands of a job, split at `&&`. */
function commands(text: string): string[] {
  return [...text.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)].flatMap((m) =>
    (m[1] ?? '').split('&&').map((c) => c.trim()),
  )
}

it('pnpm check runs the dependency audit', () => {
  expect(scripts['deps:audit']).toBe('pnpm audit --audit-level=high')
  expect(scripts['check']).toContain('pnpm deps:audit')
})

it('every pnpm step of the CI web job is a step of pnpm check', () => {
  const steps = commands(job('web'))
    .filter((c) => c.startsWith('pnpm ') && !/^pnpm (install|exec|ui:build)\b/.test(c))
    .map((c) => c.replace(/^pnpm /, ''))
  expect(steps.length).toBeGreaterThan(5)
  const missing = steps.filter((s) => !scripts['check']?.split(' && ').includes(`pnpm ${s}`))
  expect(missing).toEqual([])
})

it('every cargo step of the CI rust job is a step of pnpm rust:check', () => {
  const steps = commands(job('rust')).filter((c) => c.startsWith('cargo '))
  expect(steps.length).toBeGreaterThan(2)
  const missing = steps.filter((s) => !scripts['rust:check']?.includes(s))
  expect(missing).toEqual([])
  // CI runs cargo-deny through its action; the local script runs the tool.
  expect(job('rust')).toContain('EmbarkStudios/cargo-deny-action')
  expect(scripts['rust:check']).toContain('cargo deny check')
})

it('documentation-only pull requests still get a policy run', () => {
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:'))
  expect(trigger).not.toMatch(/paths-ignore/)
  expect(job('policy')).toContain("needs.changes.outputs.code == 'false'")
  expect(commands(job('policy'))).toEqual(
    expect.arrayContaining(['pnpm format:check', 'pnpm exec vitest run tests/policy']),
  )
  for (const name of ['web', 'rust']) {
    expect(job(name)).toContain("needs.changes.outputs.code == 'true'")
  }
})

it('CI runs on every pull request and by hand, with no label gate', () => {
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:'))
  expect(trigger).toMatch(/^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]$/m)
  expect(trigger).toMatch(/^ {2}workflow_dispatch:/m)
  expect(workflow).not.toMatch(/labels?\b/)
  // The first job decides what runs; a condition on it would skip every job,
  // and a skipped required check reads as passing.
  expect(job('changes')).not.toMatch(/^ {4}if:/m)
  const concurrency = /concurrency:\n((?: {2}.*\n)+)/.exec(workflow)?.[1] ?? ''
  expect(concurrency).toContain('group: ci-${{ github.ref }}\n')
  expect(concurrency).toContain('cancel-in-progress: true')
})

it('Playwright traces are uploaded unless the run was cancelled', () => {
  const web = job('web')
  const upload = /^\s*- if: (.*)\n\s*uses: actions\/upload-artifact@v4/m.exec(web)
  expect(upload?.[1]).toBe('${{ !cancelled() }}')
  expect(web).toContain('if-no-files-found: ignore')
})

// A tiny stand-in for lefthook's glob matcher (gobwas): `**` crosses
// folders, `*` does not, and `/**/` needs a folder between the slashes.
function globMatches(glob: string, path: string): boolean {
  const source = glob.replace(/\*\*|\*|[.+^$()|[\]\\]/g, (m) =>
    m === '**' ? '.*' : m === '*' ? '[^/]*' : `\\${m}`,
  )
  return new RegExp(`^${source}$`).test(path)
}

it('the rustfmt hook covers every Rust file, including the top-level build scripts', () => {
  const hook = /- name: rustfmt\n((?: {6}.*\n)+)/.exec(lefthook)?.[1] ?? ''
  const globs = [...hook.matchAll(/glob:\s*(.+)/g)].map((m) => (m[1] ?? '').replace(/['"]/g, ''))
  const listed = [...hook.matchAll(/^\s+- ['"]?(src-tauri\/\S+?)['"]?\s*$/gm)].map(
    (m) => m[1] ?? '',
  )
  const patterns = [...globs, ...listed]
  const files = ['src-tauri/build.rs', 'src-tauri/build_env.rs', 'src-tauri/src/lib.rs']
  const skipped = files.filter((file) => !patterns.some((g) => globMatches(g, file)))
  expect(skipped).toEqual([])
})

it('the pre-push hook checks formatting', () => {
  const push = lefthook.slice(lefthook.indexOf('pre-push:'))
  expect(push).toContain('pnpm format:check')
  expect(push).toContain('cargo fmt --check')
})

it('the README lists the audit script', () => {
  expect(read('README.md')).toContain('pnpm deps:audit')
})

// scripts/ci/changed-code.sh decides which CI jobs a pull request needs.
function changedCode(files: string[]): string {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  }).trim()
}

it('changed-code.sh calls a change documentation-only when every file is a doc', () => {
  expect(changedCode(['docs/architecture.md', 'README.md', 'docs/adr/0001.md'])).toBe('code=false')
  expect(changedCode(['docs/images/flow.png'])).toBe('code=false')
})

it('changed-code.sh runs the full checks when any file is not a doc', () => {
  expect(changedCode(['docs/architecture.md', 'src/core/x.ts'])).toBe('code=true')
  expect(changedCode(['.github/workflows/ci.yml'])).toBe('code=true')
  expect(changedCode(['tests/policy/ci-config.test.ts'])).toBe('code=true')
  expect(changedCode(['package.json'])).toBe('code=true')
})

it('changed-code.sh runs the full checks when it learns of no files', () => {
  expect(changedCode([])).toBe('code=true')
})

it('the changes job lists both paths of a rename, so code moved into docs is still built', () => {
  const command = /git diff (.*?) \| sh scripts\/ci\/changed-code\.sh/.exec(job('changes'))?.[1]
  expect(command).toBeDefined()
  const args = (command ?? '').split(/\s+/)
  expect(args).toContain('--no-renames')

  // Run the workflow's own diff arguments on a commit that moves a source file into docs/.
  const repo = tempDir('devot-rename-')
  const git = (...a: string[]) => gitIn(repo, ...a)
  git('init', '-q')
  git('config', 'user.email', 'ci@example.invalid')
  git('config', 'user.name', 'ci')
  mkdirSync(join(repo, 'src'))
  mkdirSync(join(repo, 'docs'))
  writeFileSync(join(repo, 'src/foo.ts'), 'export const foo = 1\n'.repeat(20))
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  renameSync(join(repo, 'src/foo.ts'), join(repo, 'docs/foo.md'))
  git('add', '-A')
  git('commit', '-q', '-m', 'move')
  const flags = args.filter((a) => a.startsWith('--'))
  const names = git('diff', ...flags, 'HEAD~1', 'HEAD')
  expect(names.split('\n').filter(Boolean).sort()).toEqual(['docs/foo.md', 'src/foo.ts'])
  expect(changedCode(names.split('\n').filter(Boolean))).toBe('code=true')
})
