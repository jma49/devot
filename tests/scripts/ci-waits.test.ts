import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parts, selection, testClasses } from '../../scripts/ci/screens-shards'
import { verdict, waitFor } from '../../scripts/ci/wait-for-artifact'
import { tempDir } from '../support/temp-dirs'

it('waits for the artifact while its job runs and stops when the job ended without it', async () => {
  expect(verdict({ artifact: true, conclusion: undefined })).toBe('ready')
  expect(verdict({ artifact: true, conclusion: 'failure' })).toBe('ready')
  expect(verdict({ artifact: false, conclusion: undefined })).toBe('wait')
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'success']) {
    expect(verdict({ artifact: false, conclusion })).toBe('failed')
  }
  const slept: number[] = []
  const sleep = (ms: number) => {
    slept.push(ms)
    return Promise.resolve()
  }
  const seen = [
    { artifact: false, conclusion: undefined },
    { artifact: false, conclusion: undefined },
    { artifact: true, conclusion: undefined },
  ]
  const ready = await waitFor(
    () => Promise.resolve(seen.shift()!),
    { everyMs: 10, limitMs: 100 },
    sleep,
  )
  expect(ready).toEqual({ verdict: 'ready', waitedMs: 20, conclusion: undefined })
  expect(slept).toEqual([10, 10])
  const failed = await waitFor(
    () => Promise.resolve({ artifact: false, conclusion: 'failure' }),
    { everyMs: 10, limitMs: 100 },
    sleep,
  )
  expect(failed).toEqual({ verdict: 'failed', waitedMs: 0, conclusion: 'failure' })
  const never = await waitFor(
    () => Promise.resolve({ artifact: false, conclusion: undefined }),
    { everyMs: 10, limitMs: 30 },
    sleep,
  )
  expect(never).toEqual({ verdict: 'wait', waitedMs: 30, conclusion: undefined })
})

it('splits the screens tests into parts that together run every class once, and more', () => {
  const classes = testClasses('src-tauri/apple/DevotScreens/Tests/DevotScreensTests')
  expect(classes.length).toBeGreaterThan(40)
  const [first, second] = parts(classes, 2)
  expect([...first!, ...second!].toSorted()).toEqual(classes.map(([name]) => name))
  const tests = (names: string[]) =>
    names.reduce((sum, name) => sum + (classes.find(([n]) => n === name)?.[1] ?? 0), 0)
  expect(Math.abs(tests(first!) - tests(second!))).toBeLessThan(20)
  expect(selection('1/2', classes)).toEqual(
    first!.map((name) => `-only-testing:DevotScreensTests/${name}`),
  )
  // The last part skips what the others run, so a class the list misses still runs.
  expect(selection('2/2', classes)).toEqual(
    first!.map((name) => `-skip-testing:DevotScreensTests/${name}`),
  )
  expect(selection('1/1', classes)).toEqual([])
  for (const part of ['0/2', '3/2', 'x', '']) {
    expect(() => selection(part, classes)).toThrow(`E_SCREENS_PART part=${part}`)
  }
})

function shim(home: string, env: Record<string, string>, args: string[]) {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  const real = join(bin, 'xcodebuild')
  writeFileSync(real, '#!/bin/sh\necho "real $*"\n')
  chmodSync(real, 0o755)
  return spawnSync('sh', ['scripts/shims/xcodebuild', ...args], {
    env: {
      PATH: `${join(process.cwd(), 'scripts/shims')}:${bin}:${process.env['PATH']}`,
      HOME: home,
      ...env,
    },
    encoding: 'utf8',
  })
}

it("makes a simulator archive of the app the build left, only when CI's build asks for it", () => {
  const home = tempDir('devot-xcodebuild-shim-')
  const products = join(home, 'Library/Developer/Xcode/DerivedData/devot-abc/Build/Products')
  mkdirSync(join(products, 'debug-iphonesimulator/Devot.app'), { recursive: true })
  writeFileSync(join(products, 'debug-iphonesimulator/Devot.app/Info.plist'), 'built')
  const archive = join(home, 'archives/devot_iOS')
  const args = ['-scheme', 'devot_iOS', '-sdk', 'iphonesimulator', '-configuration', 'debug']
  const archiving = [...args, 'archive', '-archivePath', archive]

  // Without the variable, and for a build, xcodebuild runs as it is.
  expect(shim(home, {}, archiving).stdout).toBe(`real ${archiving.join(' ')}\n`)
  const build = shim(home, { DEVOT_IOS_SKIP_ARCHIVE: '1' }, [...args, 'build'])
  expect(build.stdout).toBe(`real ${[...args, 'build'].join(' ')}\n`)
  // A device archive is the build that ships: never taken from an earlier build.
  const device = archiving.map((a) => (a === 'iphonesimulator' ? 'iphoneos' : a))
  expect(shim(home, { DEVOT_IOS_SKIP_ARCHIVE: '1' }, device).stdout).toBe(
    `real ${device.join(' ')}\n`,
  )
  expect(existsSync(`${archive}.xcarchive`)).toBe(false)

  const made = shim(home, { DEVOT_IOS_SKIP_ARCHIVE: '1' }, archiving)
  expect(made.status).toBe(0)
  expect(made.stdout).not.toContain('real ')
  expect(
    readFileSync(`${archive}.xcarchive/Products/Applications/Devot.app/Info.plist`, 'utf8'),
  ).toBe('built')

  const empty = tempDir('devot-xcodebuild-shim-')
  const none = shim(empty, { DEVOT_IOS_SKIP_ARCHIVE: '1' }, archiving)
  expect(none.status).toBe(1)
  expect(none.stderr).toContain('E_IOS_ARCHIVE_NO_BUILD')
})

it("CI's simulator build skips the archive and the Intel slices, and no shipping build does", () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const build = /^ {2}iphone-build:\n((?: {4,}.*\n|\n)*)/m.exec(ci)?.[1] ?? ''
  expect(build).toContain("DEVOT_IOS_SKIP_ARCHIVE: '1'")
  expect(build).toContain('echo \'EXCLUDED_ARCHS = x86_64\' > "$RUNNER_TEMP/simulator.xcconfig"')
  expect(build).toContain(
    'echo "XCODE_XCCONFIG_FILE=$RUNNER_TEMP/simulator.xcconfig" >> "$GITHUB_ENV"',
  )
  expect(ci.split('DEVOT_IOS_SKIP_ARCHIVE')).toHaveLength(2)
  for (const file of ['release.yml', 'app-store.yml']) {
    const text = readFileSync(`.github/workflows/${file}`, 'utf8')
    expect({ file, skips: /DEVOT_IOS_SKIP_ARCHIVE|XCODE_XCCONFIG_FILE/.test(text) }).toEqual({
      file,
      skips: false,
    })
  }
  expect(
    execFileSync('git', ['ls-files', '-s', 'scripts/shims/xcodebuild'], { encoding: 'utf8' }),
  ).toMatch(/^100755 /)
})
