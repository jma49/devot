import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { gitIn } from '../support/git-files'
import { tempDir } from '../support/temp-dirs'

// The documented gate must be the real one: `pnpm check` runs what CI runs.

const read = (path: string) => readFileSync(path, 'utf8')
const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
const workflow = read('.github/workflows/ci.yml')
const lefthook = read('lefthook.yml')

function job(name: string): string {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\n)*)`, 'm').exec(workflow)
  if (!match) throw new Error(`ci.yml has no job ${name}`)
  return match[1] ?? ''
}

function commands(text: string): string[] {
  return [...text.matchAll(/^\s*(?:-\s+)?run:\s*(.+)$/gm)].flatMap((m) =>
    (m[1] ?? '').split('&&').map((c) => c.trim()),
  )
}

it('pnpm check runs the dependency audit', () => {
  expect(scripts['deps:audit']).toBe('pnpm audit --audit-level=high')
  expect(scripts['check']).toContain('pnpm deps:audit')
})

it('every pnpm step of the CI web jobs is a step of pnpm check', () => {
  const steps = commands(job('web-checks') + job('unit-tests') + job('ui'))
    .filter((c) => c.startsWith('pnpm ') && !/^pnpm (install|exec|ui:build)\b/.test(c))
    .map((c) => c.replace(/^pnpm /, '').split(' ')[0] ?? '')
  expect(steps.length).toBeGreaterThan(5)
  expect(steps).toContain('test:ui')
  const missing = steps.filter((s) => !scripts['check']?.split(' && ').includes(`pnpm ${s}`))
  expect(missing).toEqual([])
})

it('every cargo step of the CI rust job is a step of pnpm rust:check', () => {
  const steps = commands(job('rust-check')).filter((c) => c.startsWith('cargo '))
  expect(steps.length).toBeGreaterThan(2)
  const missing = steps.filter((s) => !scripts['rust:check']?.includes(s))
  expect(missing).toEqual([])
  // CI runs cargo-deny through its action; the local script runs the tool.
  expect(job('deny')).toContain('EmbarkStudios/cargo-deny-action')
  expect(scripts['rust:check']).toContain('cargo deny check')
})

it('a pull request without web changes still gets a policy run with all of Vitest', () => {
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:'))
  expect(trigger).not.toMatch(/paths-ignore/)
  // Vitest also reads Rust sources, migrations and capabilities, so a Rust-only change still runs all of it.
  expect(commands(job('policy-check'))).toEqual(
    expect.arrayContaining(['pnpm format:check', 'pnpm test']),
  )
})

it('every job runs unless the change detection said it is not needed', () => {
  // Missing or unexpected outputs must run everything, never skip everything.
  expect(job('policy-check')).toContain("needs.changes.outputs.web != 'true'")
  expect(job('web-checks')).toContain("needs.changes.outputs.web != 'false'")
  expect(job('rust-check')).toContain("needs.changes.outputs.rust != 'false'")
  expect(job('deny')).toContain("needs.changes.outputs.rust != 'false'")
  expect(workflow).not.toMatch(/outputs\.(web|rust) == /)
})

it('documentation-only pull requests skip heavy jobs but still report every required gate', () => {
  expect(job('policy-check')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('web-checks')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('unit-tests')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('ui')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('rust-check')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('deny')).toContain("needs.changes.outputs.docs_only != 'true'")
  for (const gate of ['web', 'rust', 'policy']) {
    expect(job(gate)).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m)
  }
})

it('the web check fails when the quick checks, a UI shard or the change detection fails', () => {
  // `web` is a required check that sums up the jobs and runs even when they were skipped,
  // so a skipped job cannot read as passing a failed one.
  const web = job('web')
  expect(web).toMatch(/^ {4}needs: \[changes, web-checks, unit-tests, ui\]$/m)
  expect(web).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m)
  for (const need of ['changes', 'web-checks', 'unit-tests', 'ui']) {
    expect(web).toContain(`needs.${need}.result`)
  }
  expect(web).toMatch(/failure\|cancelled/)
})

it.each(['CHANGES', 'CHECKS', 'TESTS', 'UI'])(
  'the required gate rejects failed or cancelled %s results',
  (need) => {
    const config = parse(workflow) as {
      jobs: { web: { steps: { run: string }[] } }
    }
    const command = config.jobs.web.steps[0]!.run
    const summary = join(tempDir('devot-ci-summary-'), 'summary.md')
    const env = {
      ...process.env,
      GITHUB_STEP_SUMMARY: summary,
      CHANGES: 'success',
      CHECKS: 'success',
      TESTS: 'success',
      UI: 'success',
    }
    for (const result of ['success', 'skipped', 'failure', 'cancelled']) {
      const run = spawnSync('bash', ['-e', '-c', command], {
        env: { ...env, [need]: result },
        encoding: 'utf8',
      })
      expect(run.stderr).toBe('')
      expect(run.status).toBe(result === 'failure' || result === 'cancelled' ? 1 : 0)
    }
  },
)

it('CI runs on every pull request, main push and manual run, with no label gate', () => {
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:'))
  expect(trigger).toMatch(/^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]$/m)
  expect(trigger).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m)
  expect(trigger).toMatch(/^ {2}workflow_dispatch:/m)
  expect(workflow).not.toMatch(/labels?\b/)
  // The first job decides what runs; a condition on it would skip every job, and a skipped required check reads as passing.
  expect(job('changes')).not.toMatch(/^ {4}if:/m)
  const concurrency = /concurrency:\n((?: {2}.*\n)+)/.exec(workflow)?.[1] ?? ''
  expect(concurrency).toContain(
    "group: ci-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}\n",
  )
  expect(concurrency).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}")
})

// Stand-in for lefthook's glob matcher (gobwas): `**` crosses folders, `*` does not, `/**/` needs a folder, `{a,b}` is either.
function globMatches(glob: string, path: string): boolean {
  const source = glob.replace(/\*\*|\*|\{|\}|,|[.+^$()|[\]\\]/g, (m) =>
    m === '**'
      ? '.*'
      : m === '*'
        ? '[^/]*'
        : m === '{'
          ? '(?:'
          : m === '}'
            ? ')'
            : m === ','
              ? '|'
              : `\\${m}`,
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
  expect(push).toContain('pnpm lint')
  expect(push).toContain('cargo fmt --check')
})

it('the development guide lists the audit script', () => {
  expect(read('docs/development.md')).toContain('pnpm deps:audit')
})

function changedCode(files: string[]): string {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((line) => !line.startsWith('docs_only='))
    .join(' ')
}

function docsOnly(files: string[]): boolean {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  }).includes('docs_only=true')
}

it('changed-code.sh needs no build for documentation and the icon sources', () => {
  expect(changedCode(['docs/architecture.md', 'README.md', 'docs/adr/0001.md'])).toBe(
    'web=false rust=false',
  )
  expect(docsOnly(['docs/architecture.md', 'README.md', 'docs/adr/0001.md'])).toBe(true)
  expect(changedCode(['docs/images/flow.png'])).toBe('web=false rust=false')
  expect(changedCode(['design/app-icon/source.svg', 'design/README.md'])).toBe(
    'web=false rust=false',
  )
  expect(docsOnly(['design/app-icon/source.svg', 'design/README.md'])).toBe(false)
})

it('changed-code.sh runs both jobs for the bundled welcome Markdown, which the UI tests render', () => {
  expect(changedCode(['src/renderer/src/welcome/welcome.md'])).toBe('web=true rust=true')
  expect(changedCode(['src/renderer/src/welcome/markdown-example.md'])).toBe('web=true rust=true')
})

it('changed-code.sh sends relay changes to the policy job, which checks and tests the relay', () => {
  expect(changedCode(['relay/src/vault.ts', 'relay/wrangler.toml'])).toBe('web=false rust=false')
  expect(changedCode(['relay/src/vault.ts', 'src/core/sync/protocol.ts'])).toBe(
    'web=true rust=true',
  )
  expect(commands(job('policy-check'))).toEqual(
    expect.arrayContaining(['pnpm lint', 'pnpm typecheck', 'pnpm test']),
  )
  expect(scripts['typecheck']).toContain('relay/tsconfig.json')
  const include = /const include = \[(.*)\]/.exec(read('vitest.config.ts'))?.[1] ?? ''
  expect(include).toContain("'tests/**/*.test.{ts,tsx}'")
})

it('changed-code.sh sends licence Worker changes to the policy job, which checks and tests it', () => {
  expect(changedCode(['licence/src/app.ts', 'licence/wrangler.toml'])).toBe('web=false rust=false')
  expect(changedCode(['licence/migrations/0001_licences.sql', 'package.json'])).toBe(
    'web=true rust=true',
  )
  expect(scripts['typecheck']).toContain('licence/tsconfig.json')
  expect(read('pnpm-workspace.yaml')).toMatch(/^ {2}- licence$/m)
})

it('changed-code.sh sends the licence test vectors to the Rust job, which checks the app accepts them', () => {
  expect(changedCode(['licence/test-vectors.json'])).toBe('web=false rust=true')
  expect(changedCode(['licence/src/app.ts'])).toBe('web=false rust=false')
})

it('changed-code.sh runs both jobs for the plugin sandbox pages, which only the UI tests exercise', () => {
  expect(
    changedCode(['src-tauri/plugin-frame/runtime.js', 'src-tauri/plugin-frame/frame.csp']),
  ).toBe('web=true rust=true')
})

it('changed-code.sh needs only the Rust job for changes under src-tauri', () => {
  expect(changedCode(['src-tauri/src/lib.rs', 'src-tauri/Cargo.toml'])).toBe('web=false rust=true')
  expect(
    changedCode(['src-tauri/migrations/0014.sql', 'src-tauri/capabilities/default.json']),
  ).toBe('web=false rust=true')
  expect(changedCode(['src-tauri/icons/icon.icns', 'design/app-icon/source.png'])).toBe(
    'web=false rust=true',
  )
})

it('changed-code.sh runs the UI tests for tauri.conf.json, whose CSP they serve', () => {
  expect(changedCode(['src-tauri/tauri.conf.json'])).toBe('web=true rust=true')
})

it('changed-code.sh runs both jobs when anything else changes', () => {
  expect(changedCode(['docs/architecture.md', 'src/core/x.ts'])).toBe('web=true rust=true')
  expect(changedCode(['src-tauri/src/lib.rs', 'src/renderer/src/App.tsx'])).toBe(
    'web=true rust=true',
  )
  expect(changedCode(['.github/workflows/ci.yml'])).toBe('web=true rust=true')
  expect(changedCode(['tests/policy/ci-config.test.ts'])).toBe('web=true rust=true')
  expect(changedCode(['package.json'])).toBe('web=true rust=true')
  expect(changedCode(['design/tokens/base.tokens.json'])).toBe('web=true rust=true')
})

it('changed-code.sh runs both jobs when it learns of no files', () => {
  expect(changedCode([])).toBe('web=true rust=true')
  expect(docsOnly([])).toBe(false)
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
  expect(changedCode(names.split('\n').filter(Boolean))).toBe('web=true rust=true')
})

function pushGlobs(name: string): string[] {
  const push = lefthook.slice(lefthook.indexOf('pre-push:'))
  const block = new RegExp(`- name: ${name}\\n((?: {6}.*\\n)+)`).exec(push)?.[1] ?? ''
  return [...block.matchAll(/^\s+- ['"]?(\S+?)['"]?\s*$/gm)].map((m) => m[1] ?? '')
}
const pushedBy = (name: string, files: string[]) =>
  files.filter((file) => pushGlobs(name).some((g) => globMatches(g, file)))

it('the pre-push hook runs the Rust step only for pushes that change Rust or Cargo files', () => {
  const rust = [
    'src-tauri/build.rs',
    'src-tauri/src/lib.rs',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
    'src-tauri/tauri.conf.json',
    'src-tauri/capabilities/default.json',
    'src-tauri/migrations/0001_init.sql',
  ]
  expect(pushedBy('rust', rust)).toEqual(rust)
  expect(
    pushedBy('rust', [
      'src-tauri/icons/icon.png',
      'design/app-icon/source.svg',
      'docs/architecture.md',
    ]),
  ).toEqual([])
})

it('the pre-push hook runs the type check and unit tests for code and config, not for docs or images', () => {
  const code = ['src/core/notes.ts', 'src/renderer/src/App.tsx', 'package.json', 'vite.config.ts']
  // Vitest reads storage sources, migrations and fixtures to check them against the core.
  const rustRead = ['src-tauri/src/storage/mod.rs', 'src-tauri/migrations/0001_init.sql']
  expect(pushedBy('unit-tests', rustRead)).toEqual(rustRead)
  for (const name of ['typecheck', 'unit-tests']) {
    expect(pushedBy(name, code)).toEqual(code)
    expect(pushedBy(name, ['docs/architecture.md', 'src-tauri/icons/icon.png'])).toEqual([])
  }
})
