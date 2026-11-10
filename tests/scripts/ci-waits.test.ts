import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

function shim(home: string, marked: boolean, args: string[]) {
  const shims = join(home, 'shims')
  const bin = join(home, 'bin')
  mkdirSync(shims, { recursive: true })
  mkdirSync(bin, { recursive: true })
  copyFileSync('scripts/shims/xcodebuild', join(shims, 'xcodebuild'))
  chmodSync(join(shims, 'xcodebuild'), 0o755)
  if (marked) writeFileSync(join(shims, 'ci-simulator-build'), '')
  else rmSync(join(shims, 'ci-simulator-build'), { force: true })
  const real = join(bin, 'xcodebuild')
  writeFileSync(real, '#!/bin/sh\necho "real $*"\n')
  chmodSync(real, 0o755)
  // Tauri starts xcodebuild with little more than PATH and HOME.
  return spawnSync('xcodebuild', args, {
    env: { PATH: `${shims}:${bin}:/usr/bin:/bin`, HOME: home },
    encoding: 'utf8',
  })
}

it("makes a simulator archive of the app the build left, only in CI's simulator build", () => {
  const home = tempDir('devot-xcodebuild-shim-')
  const products = join(home, 'Library/Developer/Xcode/DerivedData/devot-abc/Build/Products')
  mkdirSync(join(products, 'debug-iphonesimulator/Devot.app'), { recursive: true })
  writeFileSync(join(products, 'debug-iphonesimulator/Devot.app/Info.plist'), 'built')
  const archive = join(home, 'archives/devot_iOS')
  const args = ['-scheme', 'devot_iOS', '-sdk', 'iphonesimulator', '-configuration', 'debug']
  const building = [...args, 'build']
  const archiving = [...args, 'archive', '-archivePath', archive]

  // Without the file, xcodebuild runs as it is.
  expect(shim(home, false, archiving).stdout).toBe(`real ${archiving.join(' ')}\n`)
  expect(shim(home, false, building).stdout).toBe(`real ${building.join(' ')}\n`)
  // With it, a simulator build leaves the Intel slice out.
  expect(shim(home, true, building).stdout).toContain(
    `real ${building.join(' ')} EXCLUDED_ARCHS=x86_64\n`,
  )
  // A device build or archive is what ships: never changed, never taken from an earlier build.
  const device = (list: string[]) => list.map((a) => (a === 'iphonesimulator' ? 'iphoneos' : a))
  for (const call of [device(building), device(archiving)]) {
    expect(shim(home, true, call).stdout).toBe(`real ${call.join(' ')}\n`)
  }
  expect(existsSync(`${archive}.xcarchive`)).toBe(false)

  const made = shim(home, true, archiving)
  expect(made.status).toBe(0)
  expect(made.stdout).not.toContain('real ')
  expect(
    readFileSync(`${archive}.xcarchive/Products/Applications/Devot.app/Info.plist`, 'utf8'),
  ).toBe('built')

  const empty = tempDir('devot-xcodebuild-shim-')
  const none = shim(empty, true, archiving)
  expect(none.status).toBe(1)
  expect(none.stderr).toContain('E_IOS_ARCHIVE_NO_BUILD')
})

it("only CI's simulator build turns the shim on, with a file no checkout has", () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const build = /^ {2}iphone-build:\n((?: {4,}.*\n|\n)*)/m.exec(ci)?.[1] ?? ''
  const mark = 'run: touch scripts/shims/ci-simulator-build'
  expect(build.indexOf(mark)).toBeGreaterThan(-1)
  expect(build.indexOf(mark)).toBeLessThan(build.indexOf('run: pnpm tauri ios build'))
  for (const file of ['ci.yml', 'release.yml', 'app-store.yml']) {
    const text = readFileSync(`.github/workflows/${file}`, 'utf8')
    expect({ file, marks: text.split('ci-simulator-build').length - 1 }).toEqual({
      file,
      marks: file === 'ci.yml' ? 1 : 0,
    })
  }
  expect(readFileSync('.gitignore', 'utf8')).toContain('\nscripts/shims/ci-simulator-build\n')
  const tracked = execFileSync('git', ['ls-files', '-s', 'scripts/shims'], { encoding: 'utf8' })
  expect(tracked).toMatch(/^100755 \S+ 0\tscripts\/shims\/xcodebuild$/m)
  expect(tracked).not.toContain('ci-simulator-build')
})
