import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { gitIn, listFiles } from '../support/git-files'
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
  // `pnpm test:ui` makes the UI tests' build itself when CI has not (tests/support/ui-servers.ts).
  const steps = commands(job('web-checks') + job('unit-tests') + job('ui-build') + job('ui'))
    .filter(
      (c) => c.startsWith('pnpm ') && !/^pnpm (install|exec|ui:build|test:ui:build)\b/.test(c),
    )
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

it('CI compiles the app for macOS and iOS and the Rust gate waits for it', () => {
  // No other job builds the Mac's or the phone's `cfg` branches, and they need Apple's SDK.
  const ios = job('ios-check')
  expect(ios).toContain('runs-on: macos-')
  expect(commands(ios)).toContain('cargo clippy --all-targets -- -D warnings')
  expect(ios).toContain("needs.changes.outputs.rust != 'false'")
  expect(ios).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(commands(ios)).toContain('rustup toolchain install')
  expect(read('src-tauri/rust-toolchain.toml')).toMatch(/^targets = \[.*"aarch64-apple-ios-sim"/m)
  expect(commands(ios)).toContain(
    'cargo clippy --lib --target aarch64-apple-ios-sim -- -D warnings',
  )
  const gate = job('rust')
  expect(gate).toContain('needs: [changes, rust-check, ios-check, deny]')
  expect(gate).toContain('IOS: ${{ needs.ios-check.result }}')
  expect(gate).toContain('for result in "$CHANGES" "$RUST" "$IOS" "$DENY"')
})

it("runs the signing scripts' tests, which need Apple's tools, on a Mac for every pull request with code", () => {
  // On the Linux runners they skip.
  const mac = job('mac-scripts')
  expect(mac).toContain('runs-on: macos-')
  expect(mac).toMatch(/^ {4}if: needs\.changes\.outputs\.docs_only != 'true'$/m)
  expect(commands(mac)).toContain('pnpm vitest run tests/scripts/macos-')
  for (const file of listFiles('.', 'tests/scripts').filter((f) => read(f).includes("'darwin'")))
    expect(file).toMatch(/^tests\/scripts\/macos-/)
})

it('the updater plugin is not a phone dependency', () => {
  // It turns on reqwest's rustls without a provider, and `tauri ios dev` then panics at launch.
  const manifest = read('src-tauri/Cargo.toml')
  const desktop = manifest.indexOf(
    '[target.\'cfg(not(any(target_os = "android", target_os = "ios")))\'.dependencies]',
  )
  const plugin = manifest.indexOf('tauri-plugin-updater =')
  const nextTable = manifest.indexOf('\n[', desktop + 1)
  expect(desktop).toBeGreaterThan(-1)
  expect(plugin).toBeGreaterThan(desktop)
  expect(plugin).toBeLessThan(nextTable)
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
  expect(job('web-checks')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('unit-tests')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('ui')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('ui-build')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('rust-check')).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(job('deny')).toContain("needs.changes.outputs.docs_only != 'true'")
  for (const gate of ['web', 'rust', 'policy']) {
    expect(job(gate)).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m)
  }
})

type Step = { if?: string; run?: string }
const policySteps = () =>
  (parse(workflow) as { jobs: Record<string, { if?: string; steps: Step[] }> }).jobs[
    'policy-check'
  ]!

it('documentation-only pull requests still run the format check and the tests that read the docs', () => {
  // README.md, CLAUDE.md, the design notes and the README images are read by policy and token tests.
  for (const file of ['README.md', 'CLAUDE.md', 'design/layout.md', 'docs/images/x.png']) {
    expect(docsOnly([file])).toBe(true)
  }
  const policy = policySteps()
  expect(policy.if).toBe("needs.changes.outputs.web != 'true'")
  const runs = (condition: string) =>
    policy.steps.filter((s) => s.if === condition).map((s) => s.run)
  expect(policy.steps.find((s) => s.run === 'pnpm format:check')?.if).toBeUndefined()
  expect(runs("needs.changes.outputs.docs_only == 'true'")).toEqual(['pnpm test:policy'])
  expect(runs("needs.changes.outputs.docs_only != 'true'")).toEqual(
    expect.arrayContaining(['pnpm lint', 'pnpm typecheck', 'pnpm test']),
  )
  const policyRun = scripts['test:policy']?.split(' ') ?? []
  expect(policyRun.slice(0, 2)).toEqual(['vitest', 'run'])
  for (const path of ['tests/policy', 'tests/tokens']) expect(policyRun).toContain(path)
})

it('uses the setup caches only where the job installs those dependencies', () => {
  for (const name of ['policy-check', 'web-checks', 'unit-tests', 'ui-build', 'ui', 'rust-check']) {
    expect(job(name)).toMatch(/actions\/setup-node@[^\n]*\n(?: {8,}.*\n)*? {10}cache: pnpm/)
  }
  const rust = job('rust-check')
  expect(rust).toContain('Swatinem/rust-cache@')
  expect(rust).toContain('workspaces: src-tauri')
  expect(rust).toContain("save-if: ${{ github.ref == 'refs/heads/main' }}")
  expect(job('deny')).not.toContain('Swatinem/rust-cache@')
})

it('reuses the browser packages but still installs them, and saves them once from main', () => {
  const ui = job('ui')
  const restore = ui.indexOf('actions/cache/restore@')
  const install = ui.indexOf('run: pnpm exec playwright install --with-deps webkit')
  const save = ui.indexOf('actions/cache/save@')
  expect(restore).toBeGreaterThan(0)
  expect(install).toBeGreaterThan(restore)
  expect(save).toBeGreaterThan(install)
  const saving = ui.slice(ui.lastIndexOf('- if:', save), save)
  expect(saving).toContain("github.ref == 'refs/heads/main'")
  expect(saving).toContain('matrix.shard == 1')
  expect(saving).toContain("matrix.project == 'webkit'")
  expect(saving).toContain("steps.apt.outputs.cache-hit != 'true'")
})

it('caches the WebKit download per Playwright version, restored by every shard and saved once from main', () => {
  const ui = job('ui')
  const version = ui.indexOf('id: playwright-version')
  const restore = ui.indexOf('id: browsers')
  const install = ui.indexOf('run: pnpm exec playwright install --with-deps webkit')
  expect(version).toBeGreaterThan(0)
  expect(restore).toBeGreaterThan(version)
  expect(install).toBeGreaterThan(restore)
  const restoring = ui.slice(restore, ui.indexOf('\n      - ', restore))
  expect(restoring).toContain('actions/cache/restore@')
  expect(restoring).toContain('path: ~/.cache/ms-playwright')
  expect(restoring).toContain('steps.playwright-version.outputs.version')
  const saveAt = ui.indexOf('path: ~/.cache/ms-playwright', install)
  expect(saveAt).toBeGreaterThan(install)
  const saving = ui.slice(ui.lastIndexOf('- if:', saveAt), saveAt)
  expect(saving).toContain('actions/cache/save@')
  expect(saving).toContain("github.ref == 'refs/heads/main'")
  expect(saving).toContain("steps.browsers.outputs.cache-hit != 'true'")
  expect(ui.slice(saveAt, ui.indexOf('\n      - ', saveAt))).toContain(
    'key: ${{ steps.browsers.outputs.cache-primary-key }}',
  )
})

it('builds no UI for the Rust jobs, which compile against a placeholder page', () => {
  // generate_context! needs frontendDist to exist; no Rust test reads the real pages.
  for (const name of ['rust-check', 'ios-check']) {
    const body = job(name)
    expect({ name, builds: /ui:build|vite build/.test(body) }).toEqual({ name, builds: false })
    expect(body).toContain('dist/index.html')
  }
  // The relay tests start the Node relay, so the Linux job still installs the packages.
  expect(commands(job('rust-check'))).toContain('pnpm install --frozen-lockfile')
  expect(job('ios-check')).not.toContain('pnpm install')
  expect(read('src-tauri/tauri.conf.json')).toContain('"frontendDist": "../dist"')
})

it("builds the UI tests' bundle once per run and every UI shard tests that build", () => {
  // The dev server sends each module of a page on its own, hundreds per page load.
  const build = parse(workflow) as {
    jobs: Record<
      string,
      {
        needs?: string[]
        if?: string
        env?: Record<string, string>
        steps: { uses?: string; run?: string; with?: Record<string, unknown> }[]
      }
    >
  }
  const builder = build.jobs['ui-build']!
  const shards = build.jobs['ui']!
  expect(builder.if).toBe(shards.if)
  expect(builder.steps.map((s) => s.run).filter(Boolean)).toEqual([
    'pnpm install --frozen-lockfile',
    'pnpm test:ui:build',
  ])
  const upload = builder.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'))
  expect(upload?.with).toMatchObject({ name: 'ui-test-dist', path: 'dist-test/' })
  expect(shards.needs).toEqual(['changes', 'ui-build'])
  expect(shards.env).toMatchObject({ DEVOT_UI_PREBUILT: '1' })
  const steps = shards.steps
  const download = steps.findIndex((s) => s.uses?.startsWith('actions/download-artifact@'))
  expect(steps[download]?.with).toEqual({ name: 'ui-test-dist', path: 'dist-test' })
  expect(steps.findIndex((s) => s.run?.startsWith('pnpm test:ui '))).toBeGreaterThan(download)
  expect(commands(job('ui')).some((c) => /vite build|test:ui:build/.test(c))).toBe(false)
  // The same build as a local run's, which Playwright makes when none is there.
  expect(scripts['test:ui:build']).toBe(
    'DEVOT_SENTRY_DSN= vite build --config vite.ui-test.config.ts --outDir ../../dist-test --emptyOutDir',
  )
  expect(read('tests/support/ui-servers.ts')).toContain('`pnpm test:ui:build && ${command}`')
  expect(read('playwright.config.ts')).toContain('webServer: uiWebServers(')
})

it('the UI shard plan knows nearly every spec and no removed one', () => {
  // An unrecorded spec is priced at the median, so a few new ones are fine; many unbalance the shards.
  const durations = JSON.parse(read('scripts/ci/ui-durations.json')) as Record<string, number>
  const specs = listFiles('.', 'tests').filter((f) => /^tests\/ui(?:-csp)?\/.+\.spec\.ts$/.test(f))
  expect(specs.length).toBeGreaterThan(100)
  const unrecorded = specs.filter((spec) => !(spec in durations))
  expect(unrecorded.length, `refresh ui-durations.json for ${unrecorded}`).toBeLessThanOrEqual(5)
  expect(Object.keys(durations).filter((spec) => !specs.includes(spec))).toEqual([])
})

it('the web check fails when the quick checks, the UI build, a UI shard, the Mac script tests or the change detection fails', () => {
  // `web` is a required check that sums up the jobs and runs even when they were skipped,
  // so a skipped job cannot read as passing a failed one. A failed UI build skips every shard.
  const web = job('web')
  expect(web).toMatch(
    /^ {4}needs: \[changes, web-checks, unit-tests, ui-build, ui, mac-scripts\]$/m,
  )
  expect(web).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m)
  for (const need of ['changes', 'web-checks', 'unit-tests', 'ui-build', 'ui', 'mac-scripts']) {
    expect(web).toContain(`needs.${need}.result`)
  }
  expect(web).toMatch(/failure\|cancelled/)
})

it.each(['CHANGES', 'CHECKS', 'TESTS', 'UI_BUILD', 'UI', 'MAC'])(
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
      UI_BUILD: 'success',
      UI: 'success',
      MAC: 'success',
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

it('CI runs on every pull request, merge queue entry, main push and manual run, with no label gate', () => {
  const trigger = workflow.slice(0, workflow.indexOf('\njobs:'))
  expect(trigger).toMatch(/^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened\]$/m)
  expect(trigger).toMatch(/^ {2}merge_group:\n {4}types: \[checks_requested\]$/m)
  expect(trigger).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m)
  expect(trigger).toMatch(/^ {2}workflow_dispatch:/m)
  expect(workflow).not.toMatch(/labels?\b/)
  // The first job decides what runs; a condition on it would skip every job, and a skipped required check reads as passing.
  expect(job('changes')).not.toMatch(/^ {4}if:/m)
  // Only a pull request runs a subset: a merge queue entry tests everything, as main will be.
  expect(job('changes')).toContain('if [ "$EVENT" = pull_request ]; then')
})

it('a newer push supersedes a pull request or main run, and a merge queue entry is never cancelled', () => {
  const { concurrency } = parse(workflow) as {
    concurrency: { group: string; 'cancel-in-progress': string }
  }
  expect(concurrency.group).toContain("format('pr-{0}', github.event.pull_request.number)")
  expect(concurrency.group).toContain("github.event_name == 'push' && 'main'")
  expect(concurrency.group).toContain("github.event_name == 'merge_group' && github.ref")
  expect(concurrency['cancel-in-progress']).toBe(
    "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
  )
})

it('the title check reports in the merge queue, where it has no title to read', () => {
  const titles = parse(read('.github/workflows/pr-title.yml')) as {
    on: Record<string, { types: string[] }>
    jobs: { title: { steps: { if?: string }[] } }
  }
  expect(titles.on['merge_group']?.types).toEqual(['checks_requested'])
  expect(
    titles.jobs.title.steps.every((step) => step.if === "github.event_name == 'pull_request'"),
  ).toBe(true)
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
  expect(changedCode(['package.json'])).toBe('web=true rust=true')
  expect(changedCode(['design/tokens/base.tokens.json'])).toBe('web=true rust=true')
})

it('changed-code.sh needs only the web jobs for TypeScript tests and UI specs', () => {
  expect(changedCode(['tests/policy/ci-config.test.ts', 'tests/ui/editor.spec.ts'])).toBe(
    'web=true rust=false',
  )
  expect(changedCode(['tests/support/budget.ts'])).toBe('web=true rust=false')
})

it('changed-code.sh runs the Rust job for every file under tests/ that the Rust tests read', () => {
  const rustSources = listFiles('.', 'src-tauri').filter((f) => f.endsWith('.rs'))
  const readByRust = rustSources.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/"((?:\.\.\/)+tests\/[\w./-]+)"/g)].map((m) =>
      normalize(join(dirname(file), m[1] ?? '')),
    ),
  )
  const shared = readByRust.filter((path) => path.startsWith('tests/'))
  expect(shared).toContain('tests/support/names.json')
  // manifest.rs names its file from CARGO_MANIFEST_DIR, which the pattern above does not resolve.
  for (const path of [...shared, 'tests/fixtures/plugins/manifests.json']) {
    expect({ path, jobs: changedCode([path]) }).toEqual({ path, jobs: 'web=true rust=true' })
  }
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

it('the pre-push hook runs the policy tests for pushes of docs and images, which they read', () => {
  const docs = ['README.md', 'CLAUDE.md', 'design/layout.md', 'docs/images/x.png', 'docs/x.webp']
  expect(pushedBy('policy-tests', docs)).toEqual(docs)
  const push = lefthook.slice(lefthook.indexOf('- name: policy-tests'))
  expect(push).toMatch(/^ {6}run: pnpm test:policy$/m)
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
