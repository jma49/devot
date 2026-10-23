import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards what went wrong on the first signed release (v0.8.0-beta.1), and keeps the updater key
// and the write token away from the dependencies' code.
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

  it('checks the signature against the public key before it publishes anything', () => {
    const verify = workflow.indexOf('release.ts verify-signature')
    expect(verify).toBeGreaterThan(0)
    expect(verify).toBeLessThan(workflow.indexOf('- name: Publish the release'))
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
    expect(jobNames().filter((name) => /^    environment:/m.test(job(name)))).toEqual(['sign'])
    // The build signs with a throwaway key only: Tauri will not make the updater bundle without one.
    const build = job('build')
    expect(build).toContain('tauri signer generate')
    expect(build).not.toMatch(/GITHUB_TOKEN|TAURI_SIGNING_PRIVATE_KEY: \$\{\{/)
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
    const verify = step('Verify and collect the files')
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
    for (const { name, text } of workflows) {
      const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(.*)$/gm)].map((m) => m[1]!)
      expect({ name, count: uses.length }).not.toEqual({ name, count: 0 })
      const loose = uses.filter((u) => !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/.test(u))
      expect({ name, loose }).toEqual({ name, loose: [] })
    }
  })

  it('name the Rust toolchain, the same one everywhere', () => {
    const toolchains = workflows.flatMap(({ text }) =>
      [...text.matchAll(/uses: dtolnay\/rust-toolchain@.*\n\s+with:\n(?:\s+\w+: .*\n)*/g)].map(
        (m) => /toolchain: (\S+)/.exec(m[0])?.[1],
      ),
    )
    expect(toolchains.length).toBeGreaterThan(1)
    expect(toolchains[0]).toMatch(/^\d+\.\d+\.\d+$/)
    expect(new Set(toolchains).size).toBe(1)
  })
})
