import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards what went wrong on the first signed release (v0.8.0-beta.1), and keeps the Apple
// credentials, the updater key and the write token away from the dependencies' code.
const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const workflows = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({
    name,
    text: readFileSync(join('.github/workflows', name), 'utf8'),
  }))

function job(name: string): string {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\n)*)`, 'm').exec(workflow)
  if (!match) throw new Error(`E_TEST_NO_JOB ${name}`)
  return match[1] ?? ''
}

const jobNames = () => [...workflow.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!)

function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`)
  if (start < 0) throw new Error(`E_TEST_NO_STEP ${name}`)
  const next = workflow.indexOf('\n      - ', start + 1)
  return workflow.slice(start, next < 0 ? undefined : next)
}

describe('the release workflow', () => {
  it('saves no Rust cache: a tag cache serves no later tag and crowds out main', () => {
    const build = job('build')
    expect(build).toContain('Swatinem/rust-cache@')
    expect(build).toMatch(/rust-cache@[^\n]*\n(?: {8,}.*\n)*? {10}save-if: false\n/)
  })

  it('uploads only feeds it wrote, never an empty placeholder (GitHub refuses one)', () => {
    const feeds = step('Update the feeds')
    expect(feeds).not.toMatch(/(^|\s): >|touch /m)
    const uploads = [...feeds.matchAll(/gh release upload updater (\S+)/g)].map((m) => m[1])
    expect(uploads.length).toBeGreaterThan(0)
    for (const file of uploads) expect(file).toMatch(/^"feed\//)
  })

  it('can run again after a failure: the release and the feed release may exist', () => {
    const publish = step('Publish the release')
    expect(publish).toMatch(
      /if gh release view "\$TAG"[^\n]*; then\s+gh release upload "\$TAG" out\/\* --clobber/,
    )
    expect(step('Update the feeds')).toMatch(
      /gh release create updater [^|]*\|\| gh release view updater/,
    )
  })

  it('keeps an older stable release from taking the Latest mark', () => {
    const publish = step('Publish the release')
    expect(publish).toMatch(/release\.ts latest "\$TAG" "\$current"/)
    expect(publish).toMatch(/--latest=false/)
  })

  it('checks the signature against the public key before it publishes anything', () => {
    const verify = workflow.indexOf('release.ts verify-signature')
    expect(verify).toBeGreaterThan(0)
    expect(verify).toBeLessThan(workflow.indexOf('- name: Publish the release'))
  })

  it('checks the documented release gate before it builds', () => {
    const gate = step('Check the merged pull request passed CI')
    expect(gate).toContain('release.ts ci-gate')
    expect(gate).toContain('merge_commit_sha')
    // A pull request's own run tests only what its files need, so it does not count: the run
    // that does is a full one on the tagged commit itself.
    expect(gate).toContain('ci.yml/runs?head_sha=$sha&per_page=100')
    expect(gate).toContain('.conclusion == "success"')
    expect(gate).toContain('(.event == "push" and .head_branch == "main")')
    expect(gate).toContain('.event == "merge_group"')
    expect(gate).toContain('.event == "workflow_dispatch"')
    expect(gate).not.toContain('pull_request"')
    expect(gate).toContain('release.ts ci-gate "$pr" "$green"')
    const script = (text: string) =>
      text.slice(
        text.indexOf('sha=$(git rev-parse HEAD)'),
        text.indexOf('then run this job again.'),
      )
    expect(script(gate).length).toBeGreaterThan(500)
    expect(script(readFileSync('.github/workflows/app-store.yml', 'utf8'))).toBe(script(gate))
    expect(workflow.indexOf('- name: Check the merged pull request passed CI')).toBeLessThan(
      workflow.indexOf('- name: Build'),
    )
  })

  it('keeps the token out of every checkout', () => {
    const checkouts = workflow.match(
      /uses: actions\/checkout@.*\n\s+with:\n(?:\s+(?:#.*|\w[\w-]*: .*)\n)*/g,
    )
    expect(checkouts?.length).toBe(workflow.match(/uses: actions\/checkout@/g)?.length)
    for (const checkout of checkouts ?? []) expect(checkout).toContain('persist-credentials: false')
  })

  it('reads the repository unless a job publishes', () => {
    const top = workflow.slice(0, workflow.indexOf('\njobs:'))
    expect(top).toMatch(/^permissions:\n {2}contents: read$/m)
    const writers = jobNames().filter((name) => /contents: write/.test(job(name)))
    expect(writers).toEqual(['publish', 'feed'])
    for (const name of writers)
      expect(job(name)).not.toMatch(/\bpnpm\b|(?<!package-manager-)cache:/)
  })

  it('gives the updater key only to the sign job, which runs no dependency code', () => {
    const holders = jobNames().filter((name) =>
      job(name).includes('secrets.TAURI_SIGNING_PRIVATE_KEY'),
    )
    expect(holders).toEqual(['sign'])
    expect(
      workflow.match(/\$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)? \}\}/g)?.length,
    ).toBe(2)
    const sign = job('sign')
    expect(sign).not.toMatch(
      /\bpnpm\b|\bnpx\b|\bnpm\b|\bcargo\b|(?<!package-manager-)cache:|GITHUB_TOKEN/,
    )
    expect(sign).toContain('release.ts sign "$TAG"')
    expect(sign).toMatch(/^    environment: release$/m)
    expect(jobNames().filter((name) => /^    environment:/m.test(job(name)))).toEqual([
      'sentry',
      'notarize',
      'sign',
    ])
    expect(job('build')).not.toMatch(/GITHUB_TOKEN|TAURI_SIGNING_PRIVATE_KEY/)
  })

  it('gives the Apple credentials only to the notarize job, never to the build', () => {
    const uses = (name: string) =>
      [...job(name).matchAll(/\$\{\{ (secrets|vars)\.(APPLE_\w+) \}\}/g)].map(
        (m) => `${m[1]}.${m[2]}`,
      )
    expect(uses('notarize').sort()).toEqual([
      'secrets.APPLE_API_KEY_P8',
      'secrets.APPLE_CERTIFICATE',
      'secrets.APPLE_CERTIFICATE_PASSWORD',
      'secrets.APPLE_PROVISIONING_PROFILE_MACOS',
      'vars.APPLE_API_ISSUER_ID',
      'vars.APPLE_API_KEY_ID',
      'vars.APPLE_SIGNING_IDENTITY',
    ])
    for (const name of jobNames().filter((other) => other !== 'notarize'))
      expect({ name, apple: job(name).match(/APPLE_/g) }).toEqual({ name, apple: null })
  })

  it("notarizes in the release environment, running only Apple's tools and committed scripts", () => {
    const notarize = job('notarize')
    expect(notarize).toMatch(/^    environment: release$/m)
    expect(notarize).toMatch(/^    runs-on: macos-/m)
    expect(notarize).not.toMatch(
      /\bpnpm\b|\bnpx\b|\bnpm\b|\bnode\b|\bcargo\b|(?<!src-)\btauri\b|cache:|GITHUB_TOKEN|setup-node|action-setup/,
    )
    const actions = [...notarize.matchAll(/uses: ([\w-]+\/[\w-]+)@/g)].map((m) => m[1])
    expect(new Set(actions)).toEqual(
      new Set(['actions/checkout', 'actions/download-artifact', 'actions/upload-artifact']),
    )
    expect(step('Sign, notarize and staple the app and the dmg')).toContain(
      'scripts/release/macos-sign.sh --search-list --entitlements src-tauri/macos/Devot.entitlements ',
    )
  })

  it('hands the provisioning profile to the signing script, which keeps it out of the checkout', () => {
    const signing = step('Sign, notarize and staple the app and the dmg')
    expect(signing).toContain(
      'APPLE_PROVISIONING_PROFILE: ${{ secrets.APPLE_PROVISIONING_PROFILE_MACOS }}',
    )
    expect(signing).not.toMatch(/base64|provisionprofile/)
    // The iPhone app is signed in app-store.yml (tests/policy/app-store-build.test.ts).
    expect(workflow).not.toContain('APPLE_PROVISIONING_PROFILE_IOS')
    const script = readFileSync('scripts/release/macos-sign.sh', 'utf8')
    expect(script).toMatch(/^work=\$\(mktemp -d "\$\{RUNNER_TEMP:-/m)
    expect(script).toContain('profile=$work/embedded.provisionprofile')
  })

  it('ships only what the notarize job signed: the build hands over the ad-hoc app alone', () => {
    const uploads = (name: string) =>
      [...job(name).matchAll(/uses: actions\/upload-artifact@.*\n\s+with:\n\s+name: (\S+)/g)].map(
        (m) => m[1],
      )
    expect(uploads('build')).toEqual(['app', 'sentry'])
    expect(uploads('notarize')).toEqual(['bundles'])
    expect(jobNames().filter((name) => uploads(name).includes('bundles'))).toEqual(['notarize'])
    expect(job('sign')).toMatch(/^    needs: \[build, notarize\]$/m)
    // Symlinks and extended attributes survive ditto, not an artifact of the bare folder.
    expect(step('Verify and hand over the app')).toContain(
      'ditto -c -k --keepParent "$app" handover/Devot.app.zip',
    )
    const build = step('Build')
    expect(build).toContain('--bundles app --config')
    expect(build).toContain('signingIdentity: "-"')
    expect(build).not.toContain('createUpdaterArtifacts')
  })

  it('gives the Sentry token only to the sentry job, which runs no dependency code but sentry-cli', () => {
    expect(step('Build')).not.toContain('SENTRY_AUTH_TOKEN')
    expect(job('build')).not.toContain('secrets.SENTRY_AUTH_TOKEN')
    expect(jobNames().filter((name) => job(name).includes('secrets.SENTRY_AUTH_TOKEN'))).toEqual([
      'sentry',
    ])
    const sentry = job('sentry')
    expect(sentry).toMatch(/^    environment: release$/m)
    expect(sentry).not.toMatch(/pnpm (install|i)\b|pnpm\/action-setup/)
    expect(sentry).toContain('--ignore-scripts "@sentry/cli@$version"')
    expect(sentry).toContain('node scripts/sentry/staged.ts --stage sentry-stage')
    // The build stages the maps and the dSYM in place of uploading them; the app ships neither.
    expect(step('Build')).toMatch(/^\s+DEVOT_SENTRY_STAGE: .*sentry-stage/m)
    expect(job('build')).toMatch(/name: sentry\n\s+path: sentry-stage\//)
    const staged = readFileSync('scripts/sentry/staged.ts', 'utf8')
    for (const [, from] of staged.matchAll(/^import .* from '([^']+)'$/gm)) {
      expect(from).toMatch(/^node:|^\.\/upload\.ts$/)
    }
    expect(readFileSync('scripts/sentry/upload.ts', 'utf8')).not.toMatch(/from '(?!node:)/)
  })

  it("builds the release app, which alone keeps the installed app's data and keychain items", () => {
    expect(step('Build')).toMatch(/^\s+DEVOT_RELEASE_BUILD: '1'$/m)
    expect(readFileSync('src-tauri/src/data_folder.rs', 'utf8')).toContain(
      'option_env!("DEVOT_RELEASE_BUILD")',
    )
  })

  it('binds the signature to the version the feed announces', () => {
    expect(step('Build')).toContain('requireSignedVersion: true')
    expect(step('Verify the signature')).toMatch(/release\.ts verify-signature .* "\$TAG"$/m)
  })

  it('builds through the pnpm tauri script, which puts the actool shim on PATH', () => {
    const builds = [...step('Build').matchAll(/^.*\btauri build\b.*$/gm)].map((m) => m[0].trim())
    expect(builds.length).toBeGreaterThan(0)
    expect(builds.filter((line) => !line.startsWith('pnpm tauri build '))).toEqual([])
  })

  it('checks the app carries the layered icon, which the bundler leaves out with only a log line', () => {
    const verify = step('Verify and hand over the app')
    expect(verify).toContain('test -s "$app/Contents/Resources/Assets.car"')
    expect(verify).toMatch(/plutil -extract CFBundleIconName raw "\$app\/Contents\/Info\.plist"/)
  })

  it('releases only a commit on main', () => {
    const build = job('build')
    const check = build.indexOf('git merge-base --is-ancestor HEAD origin/main')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(build.indexOf('pnpm install'))
    expect(build).toMatch(/fetch-depth: 0/)
  })

  it('moves the feeds in one job at a time, and reads each back after uploading', () => {
    const feed = job('feed')
    expect(feed).toMatch(
      /^ {4}concurrency:\n {6}group: release-feed\n {6}cancel-in-progress: false$/m,
    )
    expect(workflow.match(/gh release upload updater/g)?.length).toBe(1)
    expect(feed).toContain('gh release upload updater')
    expect(step('Update the feeds')).toMatch(
      /replaces-feed "\$TAG" "current\/\$channel\.json" "out\/\$UPDATER\.sig"/,
    )
    expect(step('Update the feeds')).toMatch(
      /gh release upload updater "feed\/\$channel\.json" --clobber\n(?:\s+#.*\n)*\s+for attempt in [\d ]+; do\n\s+rm -f "uploaded\/\$channel\.json"\n\s+gh release download updater --pattern "\$channel\.json" --dir uploaded[^\n]*\n\s+cmp -s "feed\/\$channel\.json" "uploaded\/\$channel\.json" && break\n\s+sleep \d+\n\s+done\n\s+if ! cmp -s "feed\/\$channel\.json" "uploaded\/\$channel\.json"/,
    )
  })
})

describe('the workflows', () => {
  // setup-node turns on a pnpm cache by itself when package.json names pnpm,
  // and fails where pnpm/action-setup has not installed it.
  it('cache nothing for pnpm in a job that does not install pnpm', () => {
    for (const { name, text } of workflows) {
      for (const [, body] of text.matchAll(/^ {2}[\w-]+:\n((?: {4,}.*\n|\n)*)/gm)) {
        if (!body!.includes('actions/setup-node@') || body!.includes('pnpm/action-setup@')) continue
        expect(`${name}\n${body}`).toMatch(
          /actions\/setup-node@[^\n]*\n(?: {8,}.*\n)*? {10}package-manager-cache: false/,
        )
      }
    }
  })

  it('pin every action to a commit, with the version it is', () => {
    const all = workflows.flatMap(({ text }) => [...text.matchAll(/^\s*(?:-\s+)?uses:/gm)])
    expect(all.length).toBeGreaterThan(10)
    for (const { name, text } of workflows) {
      const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)].map((m) => m[1]!)
      const loose = uses.filter((u) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(u))
      expect({ name, loose }).toEqual({ name, loose: [] })
    }
  })

  it.each([
    // The first release of each whose action.yml says `using: node24`; GitHub removes Node 20.
    ['actions/upload-artifact', [6, 0, 0]],
    ['actions/download-artifact', [7, 0, 0]],
    ['pnpm/action-setup', [4, 4, 0]],
  ] as const)('pin %s to a release that runs on Node 24', (action, first) => {
    const versions = workflows.flatMap(({ text }) =>
      [...text.matchAll(new RegExp(`uses: ${action}@[0-9a-f]{40} # v([\\d.]+)`, 'g'))].map((m) =>
        (m[1] ?? '').split('.').map(Number),
      ),
    )
    expect(versions.length).toBeGreaterThan(0)
    const older = versions.filter((v) => {
      const at = first.findIndex((part, i) => (v[i] ?? 0) !== part)
      return at !== -1 && (v[at] ?? 0) < first[at]!
    })
    expect(older.map((v) => v.join('.'))).toEqual([])
  })

  it('take the Rust toolchain from rust-toolchain.toml, never a version of their own', () => {
    const building = workflows.filter(({ text }) => /\bcargo |tauri build/.test(text))
    expect(building.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['ci.yml', 'release.yml']),
    )
    for (const { name, text } of workflows) {
      expect({ name, pinned: /dtolnay\/rust-toolchain|toolchain: \d/.test(text) }).toEqual({
        name,
        pinned: false,
      })
    }
    for (const { name, text } of building) {
      expect({ name, installs: text.includes('rustup toolchain install') }).toEqual({
        name,
        installs: true,
      })
    }
  })
})

describe('rust-toolchain.toml', () => {
  const file = readFileSync('src-tauri/rust-toolchain.toml', 'utf8')
  const list = (key: string) =>
    [
      ...(new RegExp(`^${key} = \\[(.*)\\]$`, 'm').exec(file)?.[1] ?? '').matchAll(/"([^"]+)"/g),
    ].map((m) => m[1])

  it('pins one exact release', () => {
    expect(file).toMatch(/^channel = "\d+\.\d+\.\d+"$/m)
  })

  it('brings the components CI runs', () => {
    expect(list('components')).toEqual(expect.arrayContaining(['clippy', 'rustfmt']))
  })

  it('brings every target a workflow compiles for', () => {
    const targets = workflows.flatMap(({ text }) =>
      [...text.matchAll(/cargo [^\n]*--target (\S+)/g)].map((m) => m[1]),
    )
    expect(targets.length).toBeGreaterThan(0)
    expect(list('targets')).toEqual(expect.arrayContaining(targets))
  })
})
