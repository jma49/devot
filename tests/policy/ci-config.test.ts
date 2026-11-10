import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  // CI builds cargo-deny from crates.io at a pinned version (no release download) and runs it in
  // src-tauri with the repository's toolchain, as the local script does. The binary is cached under
  // that version, so a new pin builds once.
  const deny = job('deny')
  expect(deny).toContain('working-directory: src-tauri')
  expect(commands(deny)).toContain('rustup toolchain install')
  const install = commands(deny).find((c) => c.startsWith('cargo install '))
  expect(install).toMatch(/^cargo install --locked cargo-deny@\d+\.\d+\.\d+$/)
  const version = install?.split('@')[1]
  expect(deny).toContain(`key: cargo-deny-${version}-\${{ runner.os }}-\${{ runner.arch }}`)
  expect(deny).toContain(
    "- if: steps.deny-bin.outputs.cache-hit != 'true'\n        run: cargo install",
  )
  expect(commands(deny)).toContain('cargo deny check')
  expect(deny).not.toMatch(/uses: EmbarkStudios\/cargo-deny-action@/)
  expect(scripts['rust:check']).toContain('cargo deny check')
})

it('CI compiles the app for macOS and iOS and the Rust gate waits for it', () => {
  // No other job builds the Mac's or the phone's `cfg` branches, and they need Apple's SDK.
  const ios = job('ios-check')
  // Five macOS jobs run at a time: this one takes the app build's runner once that has ended,
  // failed or not, so a pull request never has a sixth job waiting.
  const parsed = (parse(workflow) as { jobs: Record<string, { needs?: string[]; if?: string }> })
    .jobs
  expect(parsed['ios-check']!.needs).toEqual(['changes', 'iphone-build'])
  expect(parsed['ios-check']!.if).toBe(
    "${{ !cancelled() && needs.changes.outputs.rust != 'false' && needs.changes.outputs.docs_only != 'true' }}",
  )
  const startTogether = ['mac-tests', 'ios-app', 'iphone-build', 'iphone-ui']
  for (const name of startTogether) {
    expect({ name, needs: parsed[name]!.needs }).toEqual({ name, needs: 'changes' })
  }
  expect(commands(ios)).toContain('cargo clippy --all-targets -- -D warnings')
  expect(ios).toContain("needs.changes.outputs.rust != 'false'")
  expect(ios).toContain("needs.changes.outputs.docs_only != 'true'")
  expect(commands(ios)).toContain('rustup toolchain install')
  expect(read('src-tauri/rust-toolchain.toml')).toMatch(/^targets = \[.*"aarch64-apple-ios-sim"/m)
  expect(commands(ios)).toContain(
    'cargo clippy --lib --target aarch64-apple-ios-sim -- -D warnings',
  )
  expect(commands(ios)).toContain('cargo test --lib input_accessory')
  expect(commands(job('iphone-build')).some((c) => /^cargo (clippy|test)/.test(c))).toBe(false)
  const gate = job('rust')
  expect(gate).toContain(
    'needs: [changes, rust-check, ios-check, ios-app, mac-tests, iphone-build, iphone-ui, deny]',
  )
  expect(gate).toContain('IOS: ${{ needs.ios-check.result }}')
  expect(gate).toContain('IOS_APP: ${{ needs.ios-app.result }}')
  expect(gate).toContain('MAC: ${{ needs.mac-tests.result }}')
  expect(gate).toContain('IPHONE_BUILD: ${{ needs.iphone-build.result }}')
  expect(gate).toContain('IPHONE_UI: ${{ needs.iphone-ui.result }}')
  expect(gate).toContain(
    'for result in "$CHANGES" "$RUST" "$IOS" "$IOS_APP" "$MAC" "$IPHONE_BUILD" "$IPHONE_UI" "$DENY"',
  )
})

type Job = { 'runs-on'?: string; if?: string; env?: Record<string, string>; steps: Step[] }
type Workflow = { env?: Record<string, string>; jobs: Record<string, Job> }
const appleTools =
  /\b(?:xcrun|xcodebuild|swiftc|cargo|tauri|xcodegen)\b|scripts\/ci\/(?:devot|iphone)-/

it('builds and tests the iPhone app with the pinned Xcode on its iOS simulator, and ships that build', () => {
  // The iOS 27 SDK and simulators exist only on the xcode-27 image; the Mac release stays on macos-26.
  const ci = parse(workflow) as Workflow
  expect(ci.env).toEqual({ DEVOT_XCODE: '/Applications/Xcode_27.2.app', DEVOT_IOS: '27.2' })
  const store = parse(read('.github/workflows/app-store.yml')) as Workflow
  expect(store.env?.['DEVOT_XCODE']).toBe(ci.env?.['DEVOT_XCODE'])
  const iphoneJobs: [string, Job][] = [
    ...['ios-check', 'ios-app', 'iphone-build', 'iphone-ui'].map((name): [string, Job] => [
      name,
      ci.jobs[name]!,
    ]),
    ...['build', 'export'].map((name): [string, Job] => [`app-store ${name}`, store.jobs[name]!]),
  ]
  for (const [name, body] of iphoneJobs) {
    const runs = body.steps.map((step) => step.run ?? '')
    const select = runs.findIndex((run) => /^sh (?:\.\.\/)?scripts\/ci\/xcode\.sh$/.test(run))
    const firstTool = runs.findIndex((run) => appleTools.test(run))
    expect({
      name,
      image: body['runs-on'],
      select,
      beforeTools: select < firstTool || firstTool < 0,
    }).toEqual({ name, image: 'xcode-27', select: expect.any(Number), beforeTools: true })
    expect(select).toBeGreaterThanOrEqual(0)
  }
  // The app build boots none: a simulator booting beside it made the build three times slower.
  expect(job('iphone-build')).not.toContain('simctl boot')
  for (const name of ['ios-app', 'iphone-ui']) {
    const boot = ci.jobs[name]!.steps.find((step) => step.run?.includes('xcrun simctl boot'))?.run
    expect(boot).toContain('node scripts/ci/iphone-simulator.ts --os "$DEVOT_IOS"')
    expect(boot).toMatch(/echo "DEVOT_SIMULATOR=\$\w+" >> "\$GITHUB_ENV"/)
  }
  // A wait started while that background boot runs can fail with "current state: Booted"; the
  // test scripts wait through the helper, which tries once more.
  for (const script of ['devot-store-tests.sh', 'devot-screens-tests.sh', 'iphone-ui-tests.sh']) {
    const text = read(`scripts/ci/${script}`)
    expect({ script, bare: text.includes('bootstatus') }).toEqual({ script, bare: false })
    expect(text).toContain('sh "$root/scripts/ci/iphone-simulator-ready.sh" "$device"')
  }
  // A simulator's boot takes every core for minutes: tests built beside it took 13 to 14 minutes
  // against 9 to 11, so each script waits for the boot and builds after it.
  for (const script of ['devot-store-tests.sh', 'devot-screens-tests.sh']) {
    const text = read(`scripts/ci/${script}`)
    expect({ script, during: text.includes('build-for-testing') }).toEqual({
      script,
      during: false,
    })
    expect(text.indexOf('iphone-simulator-ready.sh')).toBeLessThan(text.indexOf('xcodebuild test '))
  }
  expect(read('scripts/ci/iphone-simulator-ready.sh')).toContain(
    'xcrun simctl bootstatus "$1" -b >/dev/null 2>&1 || xcrun simctl bootstatus "$1" -b >/dev/null',
  )
  const release = parse(read('.github/workflows/release.yml')) as Workflow
  for (const body of Object.values(release.jobs)) expect(body['runs-on']).not.toBe('xcode-27')
  const select = read('scripts/ci/xcode.sh')
  expect(select).toContain('sudo xcode-select -s "$xcode/Contents/Developer"')
  expect(select).toContain('E_CI_XCODE_MISSING')
  expect(select).toContain('E_CI_XCODE_VERSION')
})

it('builds the iPhone app once per run, in iphone-build, and the UI test shards only run it', () => {
  const ci = parse(workflow) as Workflow & {
    jobs: Record<string, Job & { needs?: string | string[]; permissions?: Record<string, string> }>
  }
  const builds = Object.entries(ci.jobs).flatMap(([name, body]) =>
    body.steps.filter((step) => step.run?.startsWith('pnpm tauri ios build ')).map(() => name),
  )
  expect(builds).toEqual(['iphone-build'])
  expect(ci.jobs['iphone-build']!.if).toBe(
    "needs.changes.outputs.rust != 'false' && needs.changes.outputs.docs_only != 'true'",
  )
  // A job that needs iphone-build would start only once all of it has ended. A shard starts beside
  // it, boots its simulator while the app builds and waits for the artifact, then for the app.
  const shards = ci.jobs['iphone-ui']!
  expect(shards.needs).toBe('changes')
  expect(shards.if).toBe(
    "needs.changes.outputs.iphone_ui != 'false' && needs.changes.outputs.docs_only != 'true'",
  )
  expect(shards.permissions).toEqual({ contents: 'read', actions: 'read' })
  const order = shards.steps.map((step) => step.run ?? step.uses ?? '')
  const at = (start: string) => order.findIndex((entry) => entry.includes(start))
  const wait = "node scripts/ci/wait-for-artifact.ts iphone-ui-build 'iPhone app build'"
  expect(at('xcrun simctl boot')).toBeGreaterThan(-1)
  expect(at('xcrun simctl boot')).toBeLessThan(at(wait))
  expect(at(wait)).toBeLessThan(at('actions/download-artifact@'))
  expect(ci.jobs['iphone-build']).toMatchObject({ name: 'iPhone app build' })
  // A shard gets the app and the test runner from the artifact: no install, Rust or app build.
  const runs = shards.steps.map((step) => step.run ?? '').join('\n')
  expect(runs).not.toMatch(/pnpm|cargo|rustup|xcodegen|tauri|build-for-testing/)
  for (const action of ['pnpm/action-setup@', 'Swatinem/rust-cache@']) {
    expect(shards.steps.some((step) => step.uses?.startsWith(action))).toBe(false)
  }
  expect(ci.jobs['ios-app']!.steps.some((step) => /pnpm|tauri|rustup/.test(step.run ?? ''))).toBe(
    false,
  )
  // The runner and the artifact are made only when the UI test runs, which needs the Rust jobs too.
  const steps = ci.jobs['iphone-build']!.steps
  const handOver = steps.filter(
    (step) =>
      step.run === 'sh scripts/ci/iphone-ui-tests.sh build' ||
      step.run?.startsWith('tar -C test-results') ||
      (step.uses?.startsWith('actions/upload-artifact@') &&
        step.with?.['name'] === 'iphone-ui-build'),
  )
  expect(handOver.map((step) => step.if)).toEqual(
    Array(3).fill("needs.changes.outputs.iphone_ui != 'false'"),
  )
  for (const path of [
    'src-tauri/apple/DevotScreens/Sources/DevotScreens/Screens.swift',
    'src/renderer/src/phone/PhoneApp.tsx',
    'scripts/ci/iphone-ui-tests.sh',
    'tests/fixtures/screens/valid/request-tabs-show.json',
  ]) {
    expect({ path, rust: iphoneUi([path]) && changedCode([path]).includes('rust=true') }).toEqual({
      path,
      rust: true,
    })
  }
})

it('hands the app and the test runner to the shards as one small, short-lived artifact', () => {
  const build = job('iphone-build')
  expect(commands(build)).toContain('sh scripts/ci/iphone-ui-tests.sh build')
  expect(build).toContain(
    'tar -C test-results -cf - iphone-ui-build | zstd -T0 -10 -q -o "$RUNNER_TEMP/iphone-ui-build.tar.zst"',
  )
  const upload = build.slice(build.indexOf('actions/upload-artifact@'))
  expect(upload).toContain('name: iphone-ui-build')
  expect(upload).toContain('compression-level: 0')
  expect(upload).toContain('retention-days: 1')
  // A run started again uploads the same commit's build under the same name.
  expect(upload).toContain('overwrite: true')
  const ui = job('iphone-ui')
  expect(ui.slice(ui.indexOf('actions/download-artifact@'))).toContain('name: iphone-ui-build')
  expect(commands(ui)).toEqual(
    expect.arrayContaining([
      'mkdir -p test-results',
      'zstd -dc "$RUNNER_TEMP/iphone-ui-build.tar.zst" | tar -C test-results -xf -',
      'sh scripts/ci/iphone-ui-tests.sh settle',
      'sh scripts/ci/iphone-ui-tests.sh test',
    ]),
  )
  // WebKit's first start in a cold-booted simulator is slow; tests started before it miss their
  // waits, so every job that tests starts the app once first.
  const shardCommands = commands(ui)
  expect(shardCommands.indexOf('sh scripts/ci/iphone-ui-tests.sh settle')).toBeGreaterThan(-1)
  expect(shardCommands.indexOf('sh scripts/ci/iphone-ui-tests.sh settle')).toBeLessThan(
    shardCommands.indexOf('sh scripts/ci/iphone-ui-tests.sh test'),
  )
  const script = read('scripts/ci/iphone-ui-tests.sh')
  expect(script).toContain('bundle=${DEVOT_UI_BUILD:-$root/test-results/iphone-ui-build}')
  expect(script).toContain('xcodebuild build-for-testing')
  expect(script).toContain('xcodebuild test-without-building -xctestrun "$xctestrun"')
  // A one-off stall reruns the test once; a test that fails twice still fails the job.
  expect(script).toContain('-retry-tests-on-failure -test-iterations 2')
  expect(read('scripts/ci/devot-screens-tests.sh')).toContain(
    '-retry-tests-on-failure -test-iterations 2',
  )
})

it('CI tests the StoreKit bridge and builds the iPhone app with it, and the Rust gate waits for both', () => {
  // StoreKit Test runs only inside an app, on Apple's SDK; only the full iPhone build links the
  // Swift package into the app.
  const ci = parse(workflow) as Workflow & {
    jobs: Record<string, Job & { strategy?: { matrix: { part: number[] } } }>
  }
  const app = job('ios-app')
  const build = job('iphone-build')
  // The Swift packages' tests link no Rust: a pull request runs each for its package, the fixtures
  // it reads and CI itself (changed-code.sh); every other run tests both.
  expect(ci.jobs['ios-app']!.if).toBe(
    "needs.changes.outputs.screens != 'false' && needs.changes.outputs.docs_only != 'true'",
  )
  const mac = ci.jobs['mac-tests']!
  expect(mac['runs-on']).toBe('macos-26')
  expect(mac.if).toBe(
    "(needs.changes.outputs.web != 'false' || needs.changes.outputs.storekit != 'false') && needs.changes.outputs.docs_only != 'true'",
  )
  // The StoreKit tests run also after the script tests failed.
  const store = mac.steps.filter((step) => /xcodegen|devot-store-tests/.test(step.run ?? ''))
  expect(store.map((step) => [step.run, step.if])).toEqual([
    ['brew install xcodegen', "${{ !cancelled() && needs.changes.outputs.storekit != 'false' }}"],
    [
      'sh scripts/ci/devot-store-tests.sh',
      "${{ !cancelled() && needs.changes.outputs.storekit != 'false' }}",
    ],
  ])
  expect(job('changes')).toContain('screens: ${{ steps.diff.outputs.screens }}')
  expect(job('changes')).toContain('storekit: ${{ steps.diff.outputs.storekit }}')
  for (const [path, screens, storeKit] of [
    ['src-tauri/apple/DevotScreens/Sources/DevotScreens/Screens.swift', true, false],
    ['tests/fixtures/screens/valid/request-tabs-show.json', true, false],
    ['tests/fixtures/licence-gate.json', true, false],
    ['src-tauri/apple/DevotStore/Sources/DevotStore/Store.swift', false, true],
    ['scripts/ci/devot-store-tests.sh', true, true],
    ['.github/workflows/ci.yml', true, true],
    ['src-tauri/src/lib.rs', false, false],
    ['src-tauri/src/screens/message.rs', false, false],
    ['src/renderer/src/phone/PhoneApp.tsx', false, false],
    ['package.json', false, false],
  ] as const) {
    const out = changes([path])
    expect({
      path,
      screens: out.includes('screens=true'),
      storeKit: out.includes('storekit=true'),
    }).toEqual({
      path,
      screens,
      storeKit,
    })
  }
  expect(changes([])).toEqual(expect.arrayContaining(['screens=true', 'storekit=true']))
  const steps = commands(app)
  expect(steps).toContain('brew install xcodegen')
  expect(steps).toContain('sh scripts/ci/devot-screens-tests.sh')
  // Each job boots a simulator and builds the package before its first test, so two share the classes.
  expect(ci.jobs['ios-app']!.strategy?.matrix.part).toEqual([1, 2])
  expect(ci.jobs['ios-app']!.env).toEqual({ DEVOT_SCREENS_PART: '${{ matrix.part }}/2' })
  expect(read('scripts/ci/devot-screens-tests.sh')).toContain(
    'selection=$(node "$root/scripts/ci/screens-shards.ts" "$DEVOT_SCREENS_PART")',
  )
  // The release check builds the package twice more; pull requests leave it to the merge queue.
  const releaseCheck = ci.jobs['ios-app']!.steps.find(
    (step) => step.run === 'sh scripts/ci/devot-screens-release-check.sh',
  )
  expect(releaseCheck?.if).toBe("github.event_name != 'pull_request' && matrix.part == 1")
  expect(build).toContain("needs.changes.outputs.rust != 'false'")
  expect(commands(build)).toEqual(
    expect.arrayContaining([
      'rustup toolchain install',
      'pnpm tauri ios build --debug --target aarch64-sim',
    ]),
  )
  const script = read('scripts/ci/devot-store-tests.sh')
  expect(script).toContain('src-tauri/apple/DevotStore/TestHost')
  expect(script).toContain('xcodegen generate')
  expect(script).toContain('xcodebuild test')
  expect(script).toContain('-scheme DevotStoreTests')
  expect(script).toContain('-maximum-test-execution-time-allowance 120')
  // Every test gets the whole two minutes: xcodebuild retries no test that ran out of time.
  expect(script).toContain('-default-test-execution-time-allowance 120')
})

it('launches the real iPhone app with its built UI in a simulator, switches the tabs and audits them', () => {
  // The only jobs that run the shipping app: the screens' XCTests run in an empty host app.
  const ui = job('iphone-ui')
  const build = job('iphone-build')
  expect(ui).toMatch(
    /^ {4}if: needs\.changes\.outputs\.iphone_ui != 'false' && needs\.changes\.outputs\.docs_only != 'true'$/m,
  )
  expect(commands(ui)).toContain('sh scripts/ci/iphone-ui-tests.sh test')
  expect(commands(build)).toEqual(
    expect.arrayContaining(['brew install xcodegen', 'sh scripts/ci/iphone-ui-tests.sh build']),
  )
  // Tauri's beforeBuildCommand, the release UI build, is kept: the app shows the real page.
  expect(commands(build)).toContain('pnpm tauri ios build --debug --target aarch64-sim')
  expect(read('src-tauri/tauri.conf.json')).toContain('"beforeBuildCommand": "pnpm ui:release"')
  expect(build).not.toContain('dist/index.html')
  expect(job('changes')).toContain('iphone_ui: ${{ steps.diff.outputs.iphone_ui }}')
  expect(job('changes')).toContain(
    "printf 'web=true\\nrust=true\\ndocs_only=false\\niphone_ui=true\\nscreens=true\\nstorekit=true\\n'",
  )
  const script = read('scripts/ci/iphone-ui-tests.sh')
  expect(script).toContain('src-tauri/apple/DevotUITests')
  expect(script).toContain('xcodegen generate')
  expect(script).toContain('xcrun simctl install')
  expect(script).toContain(
    'xcodebuild build-for-testing -project DevotUITests.xcodeproj -scheme DevotUITests',
  )
  // A failing run keeps its result bundle, with each test's attachments, as the evidence.
  expect(script).toContain('results="$root/test-results/iphone-ui.xcresult"')
  expect(script).toContain('-resultBundlePath "$results"')
  expect(script).toContain('retry_results="$root/test-results/iphone-ui-retry.xcresult"')
  const upload = ui.slice(ui.indexOf('- if: failure()'))
  expect(upload).toMatch(/^ {8}uses: actions\/upload-artifact@[0-9a-f]{40} # v/m)
  expect(upload).toContain('name: iphone-ui-xcresult-${{ matrix.shard }}')
  expect(upload).toContain('path: test-results/iphone-ui*.xcresult/')
  const tests = read('src-tauri/apple/DevotUITests/Tests/TabsTests.swift')
  expect(tests).toContain('performAccessibilityAudit')
  for (const tab of ['Notes', 'Library', 'Activity', 'Settings']) {
    expect(tests).toContain(`L10n.phoneTab${tab}()`)
  }
})

it('changed-code.sh runs the iPhone UI test for the native screens, the phone page and the app project', () => {
  for (const path of [
    'src-tauri/apple/DevotScreens/Sources/DevotScreens/Screens.swift',
    'src-tauri/apple/DevotUITests/Tests/TabsTests.swift',
    'src-tauri/gen/apple/project.yml',
    'src-tauri/src/native/ios/screens.rs',
    'src-tauri/src/screens/message.rs',
    'src/renderer/src/phone/PhoneApp.tsx',
    'tests/fixtures/screens/valid/request-tabs-show.json',
    'scripts/ci/iphone-ui-tests.sh',
    'scripts/ci/iphone-ui-shards.ts',
    'scripts/ci/iphone-simulator.ts',
    'scripts/ci/iphone-simulator-ready.sh',
    'scripts/ci/xcode.sh',
  ]) {
    expect({ path, iphoneUi: iphoneUi([path]) }).toEqual({ path, iphoneUi: true })
  }
  for (const path of [
    'src-tauri/src/lib.rs',
    'src-tauri/src/native/macos/window.rs',
    'src/renderer/src/App.tsx',
    'docs/specs/iphone-screens.md',
  ]) {
    expect({ path, iphoneUi: iphoneUi([path]) }).toEqual({ path, iphoneUi: false })
  }
  expect(iphoneUi([])).toBe(true)
})

it("runs the signing scripts' tests, which need Apple's tools, on a Mac for every pull request with web or script changes", () => {
  // scripts/ and tests/ count as web changes (scripts/ci/changed-code.sh).
  const ci = parse(workflow) as Workflow
  const mac = ci.jobs['mac-tests']!
  expect(mac['runs-on']).toMatch(/^macos-/)
  expect(mac.if).toContain("needs.changes.outputs.web != 'false'")
  expect(mac.if).toContain("needs.changes.outputs.docs_only != 'true'")
  const scriptTests = mac.steps.filter((step) => /^pnpm (install|vitest)/.test(step.run ?? ''))
  expect(scriptTests.map((step) => [step.run, step.if])).toEqual([
    ['pnpm install --frozen-lockfile', "needs.changes.outputs.web != 'false'"],
    [
      'pnpm vitest run tests/scripts/macos- tests/scripts/ios-',
      "needs.changes.outputs.web != 'false'",
    ],
  ])
})

it('every Vitest test that skips without a Mac or its tools runs in the macOS job', () => {
  // Reads the skipIf/runIf conditions; on the Linux runners such a test would never run at all.
  const mac =
    /'darwin'|\b(?:codesign|security|xcrun|notarytool|stapler|plutil|hdiutil|spctl|ditto|xcodebuild|actool|devicectl)\b/
  const macOnly = listFiles('.', 'tests')
    .filter((file) => /\.test\.ts$/.test(file))
    .filter((file) =>
      [...read(file).matchAll(/\.(?:skipIf|runIf)\((.*)$/gm)].some((m) => mac.test(m[1] ?? '')),
    )
  const filters = commands(job('mac-tests'))
    .filter((c) => c.startsWith('pnpm vitest run '))
    .flatMap((c) => c.split(' ').slice(3))
  expect(macOnly).toEqual(expect.arrayContaining(['tests/scripts/macos-sign.build.test.ts']))
  expect(macOnly.filter((file) => !filters.some((f) => file.startsWith(f)))).toEqual([])
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

type Step = { if?: string; run?: string; uses?: string; with?: Record<string, string> }
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

it('the iPhone build reuses Rust caches only main writes, per Xcode build, which no release build shares', () => {
  const ci = parse(workflow) as Workflow
  const rust = ci.jobs['iphone-build']!.steps.find((step) =>
    step.uses?.startsWith('Swatinem/rust-cache@'),
  )
  expect(rust?.with).toEqual({
    workspaces: 'src-tauri',
    'shared-key': 'iphone-sim',
    key: 'xcode-${{ env.DEVOT_XCODE_BUILD }}',
    'save-if': "${{ github.ref == 'refs/heads/main' }}",
  })
  expect(read('scripts/ci/xcode.sh')).toContain('echo "DEVOT_XCODE_BUILD=')
  for (const file of ['release.yml', 'app-store.yml']) {
    const text = read(`.github/workflows/${file}`)
    expect({ file, shared: text.includes('shared-key:') }).toEqual({ file, shared: false })
  }
  // pnpm's metadata cache holds its supply-chain verdict on the lockfile, so an unchanged one is not checked again.
  const build = job('iphone-build')
  const restore = build.indexOf('id: pnpm-metadata')
  const install = build.indexOf('run: pnpm install --frozen-lockfile')
  expect(restore).toBeGreaterThan(build.indexOf('id: pnpm-cache-path'))
  expect(install).toBeGreaterThan(restore)
  expect(build.slice(restore, install)).toContain(
    "key: pnpm-metadata-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml') }}",
  )
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

it('keeps the generated Swift tokens and strings current, and compiles them for the iPhone', () => {
  expect(commands(job('web-checks'))).toEqual(
    expect.arrayContaining(['pnpm tokens:check', 'pnpm i18n:apple:check', 'pnpm lint']),
  )
  expect(scripts['lint']).toContain('node scripts/tokens/swift-literals.ts')
  expect(
    commands(job('ios-check')).filter(
      (command) =>
        command.startsWith('xcrun --sdk iphonesimulator swiftc -typecheck -swift-version 6') &&
        command.endsWith('apple/DevotScreens/Sources/DevotScreens/Generated/*.swift'),
    ),
  ).toHaveLength(1)
  // The typecheck alone never runs L10n's placeholder filling.
  expect(commands(job('ios-check'))).toEqual(
    expect.arrayContaining([
      'swiftc -swift-version 6 -warnings-as-errors -o "$RUNNER_TEMP/strings-check" ' +
        'apple/DevotScreens/Sources/DevotScreens/Generated/Strings.swift ' +
        'apple/DevotScreens/Checks/main.swift',
      '"$RUNNER_TEMP/strings-check"',
    ]),
  )
  expect(existsSync('src-tauri/apple/DevotScreens/Checks/main.swift')).toBe(true)
})

it('builds no UI for the Rust jobs, which compile against a placeholder page', () => {
  // generate_context! needs frontendDist to exist; no Rust check or test reads the real pages.
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

it('the web check fails when the quick checks, the UI build, a UI shard, the macOS tests or the change detection fails', () => {
  // `web` is a required check that sums up the jobs and runs even when they were skipped,
  // so a skipped job cannot read as passing a failed one. A failed UI build skips every shard.
  const web = job('web')
  expect(web).toMatch(/^ {4}needs: \[changes, web-checks, unit-tests, ui-build, ui, mac-tests\]$/m)
  expect(web).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m)
  for (const need of ['changes', 'web-checks', 'unit-tests', 'ui-build', 'ui', 'mac-tests']) {
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
    .filter((line) => !/^(docs_only|iphone_ui|screens|storekit)=/.test(line))
    .join(' ')
}

function changes(files: string[]): string[] {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.length ? files.join('\n') + '\n' : '',
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
}

function iphoneUi(files: string[]): boolean {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  }).includes('iphone_ui=true')
}

function docsOnly(files: string[]): boolean {
  return execFileSync('sh', ['scripts/ci/changed-code.sh'], {
    input: files.join('\n') + '\n',
    encoding: 'utf8',
  }).includes('docs_only=true')
}

it('changed-code.sh needs no build for documentation and the icon sources', () => {
  expect(
    changedCode(['docs/architecture.md', 'docs/specs/ai.md', 'README.md', 'docs/adr/0001.md']),
  ).toBe('web=false rust=false')
  expect(
    docsOnly(['docs/architecture.md', 'docs/specs/ai.md', 'README.md', 'docs/adr/0001.md']),
  ).toBe(true)
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
    expect(
      pushedBy(name, ['docs/architecture.md', 'docs/specs/ai.md', 'src-tauri/icons/icon.png']),
    ).toEqual([])
  }
})
