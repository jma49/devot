import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appStoreVersion,
  bundleProblems,
  markerProblems,
  otoolStrings,
  undeclaredReasons,
  usedReasonApis,
  withAppStoreSettings,
  withICloudSettings,
} from '../../scripts/release/app-store'
import { tempDir } from '../support/temp-dirs'

const root = join(import.meta.dirname, '../..')
const script = join(root, 'scripts/release/app-store.ts')

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('the App Store version', () => {
  it('is the release version without its beta, and the build number counts every run', () => {
    expect(appStoreVersion('1.2.0', '41', '1')).toEqual({ short: '1.2.0', build: '41.1' })
    expect(appStoreVersion('1.2.0-beta3', '42', '1')).toEqual({ short: '1.2.0', build: '42.1' })
    expect(appStoreVersion('0.10.12-beta.4', '42', '3')).toEqual({
      short: '0.10.12',
      build: '42.3',
    })
  })

  it('grows with every run and every attempt, as App Store Connect needs', () => {
    const order = [
      appStoreVersion('1.2.0', '9', '1'),
      appStoreVersion('1.2.0', '9', '2'),
      appStoreVersion('1.2.0', '10', '1'),
    ].map(({ build }) => build.split('.').map(Number))
    for (let i = 1; i < order.length; i++) {
      const [runNumber, attempt] = order[i]!
      const [lastRun, lastAttempt] = order[i - 1]!
      expect(runNumber! > lastRun! || (runNumber === lastRun && attempt! > lastAttempt!)).toBe(true)
    }
  })

  it('refuses a version or a counter that is not one', () => {
    for (const [version, number, attempt] of [
      ['1.2', '1', '1'],
      ['v1.2.0', '1', '1'],
      ['1.2.0-rc1', '1', '1'],
      ['1.2.0', '0', '1'],
      ['1.2.0', '01', '1'],
      ['1.2.0', '1', ''],
      ['1.2.0', '1.5', '1'],
    ] as const) {
      expect(() => appStoreVersion(version, number, attempt)).toThrow(/^E_APP_STORE_VERSION/)
    }
  })

  it('prints both for $GITHUB_OUTPUT', () => {
    expect(run('version', '1.2.0-beta3', '42', '2')).toEqual({
      status: 0,
      stdout: 'short=1.2.0\nbuild=42.2\n',
      stderr: '',
    })
    expect(run('version', 'nope', '1', '1').status).toBe(1)
  })
})

const GOOD = {
  CFBundleIdentifier: 'io.github.jma49.devot',
  CFBundleShortVersionString: '1.2.0',
  CFBundleVersion: '42.1',
  UIDeviceFamily: [1],
  ITSAppUsesNonExemptEncryption: false,
  DevotCloudKitContainer: 'iCloud.io.github.jma49.devot',
}

describe('the archived bundle', () => {
  const expected = { short: '1.2.0', build: '42.1' }

  it('passes when it is the iPhone-only App Store build with iCloud and its version', () => {
    expect(bundleProblems(GOOD, expected)).toEqual([])
  })

  it('names each way it is not', () => {
    expect(
      bundleProblems(
        {
          ...GOOD,
          UIDeviceFamily: [1, 2],
          ITSAppUsesNonExemptEncryption: undefined,
          DevotCloudKitContainer: '',
          CFBundleVersion: '1.2.0',
        },
        expected,
      ),
    ).toEqual([
      'E_APP_STORE_DEVICE_FAMILY: UIDeviceFamily is [1,2], not iPhone only ([1])',
      'E_APP_STORE_ENCRYPTION: ITSAppUsesNonExemptEncryption is not set',
      'E_APP_STORE_ICLOUD: DevotCloudKitContainer is "", not iCloud.io.github.jma49.devot: the build lacks DEVOT_ICLOUD=YES',
      'E_APP_STORE_BUILD_NUMBER: CFBundleVersion is "1.2.0", not 42.1',
    ])
    expect(
      bundleProblems(
        {
          ...GOOD,
          CFBundleIdentifier: 'io.github.jma49.devot.dev',
          CFBundleShortVersionString: '1.2.0-beta3',
        },
        expected,
      ),
    ).toEqual([
      'E_APP_STORE_BUNDLE_ID: CFBundleIdentifier is "io.github.jma49.devot.dev", not io.github.jma49.devot',
      'E_APP_STORE_VERSION: CFBundleShortVersionString is "1.2.0-beta3", not 1.2.0',
    ])
  })

  it('checks a bundle from its JSON form', () => {
    const dir = tempDir('devot-app-store-bundle-')
    const info = join(dir, 'info.json')
    writeFileSync(info, JSON.stringify(GOOD))
    expect(run('check-bundle', info, '1.2.0', '42.1')).toMatchObject({ status: 0 })
    writeFileSync(info, JSON.stringify({ ...GOOD, UIDeviceFamily: [1, 2] }))
    const refused = run('check-bundle', info, '1.2.0', '42.1')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('::error::E_APP_STORE_DEVICE_FAMILY')
  })
})

const OTOOL = `build/Devot.app/Devot:
Contents of (__TEXT,__objc_methname) section
0000000100c1a2b0  alloc
0000000100c1a2b6  systemUptime
0000000100c1a2c3  init
`

describe('the required-reason API scan', () => {
  it('reads the strings otool prints for a section', () => {
    expect(otoolStrings(OTOOL)).toEqual(['alloc', 'systemUptime', 'init'])
    expect(
      otoolStrings('Contents of (__TEXT,__cstring) section\n0000000100c1 two words\n'),
    ).toEqual(['two words'])
  })

  it('finds each category from the functions and selectors the binary uses', () => {
    const used = usedReasonApis(
      ['_open', '_fstat', '_stat', '_statfs', '_mach_absolute_time'],
      ['alloc', 'NSUserDefaults', 'activeInputModes'],
    )
    expect(Object.fromEntries(used)).toEqual({
      NSPrivacyAccessedAPICategoryFileTimestamp: ['_stat', '_fstat'],
      NSPrivacyAccessedAPICategoryDiskSpace: ['_statfs'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['_mach_absolute_time'],
      NSPrivacyAccessedAPICategoryUserDefaults: ['NSUserDefaults'],
      NSPrivacyAccessedAPICategoryActiveKeyboards: ['activeInputModes'],
    })
    expect(usedReasonApis(['_open', '_read'], ['alloc', 'stat']).size).toBe(0)
  })

  it('counts getattrlist under both categories it can serve', () => {
    expect([...usedReasonApis(['_getattrlist'], []).keys()]).toEqual([
      'NSPrivacyAccessedAPICategoryFileTimestamp',
      'NSPrivacyAccessedAPICategoryDiskSpace',
    ])
  })

  it('names each used category the manifest gives no reason for', () => {
    const manifest = {
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: [],
        },
      ],
    }
    const used = usedReasonApis(['_stat', '_statfs', '_mach_absolute_time'], [])
    expect(undeclaredReasons(manifest, used)).toEqual([
      'E_APP_STORE_PRIVACY_UNDECLARED: NSPrivacyAccessedAPICategoryDiskSpace (_statfs) has no reason in PrivacyInfo.xcprivacy',
      'E_APP_STORE_PRIVACY_UNDECLARED: NSPrivacyAccessedAPICategorySystemBootTime (_mach_absolute_time) has no reason in PrivacyInfo.xcprivacy',
    ])
    expect(undeclaredReasons({}, usedReasonApis(['_stat'], []))).toHaveLength(1)
  })

  it('checks a binary from nm and otool output', () => {
    const dir = tempDir('devot-app-store-privacy-')
    const manifest = join(dir, 'privacy.json')
    const symbols = join(dir, 'symbols.txt')
    const strings = join(dir, 'strings.txt')
    writeFileSync(
      manifest,
      JSON.stringify({
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
        ],
      }),
    )
    writeFileSync(symbols, '_open\n_read\n')
    writeFileSync(strings, OTOOL)
    const passed = run('privacy-check', manifest, symbols, strings)
    expect(passed.status).toBe(0)
    expect(passed.stdout).toContain('NSPrivacyAccessedAPICategorySystemBootTime: systemUptime')

    writeFileSync(symbols, '_open\n_fstat\n')
    const refused = run('privacy-check', manifest, symbols, strings)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(
      '::error::E_APP_STORE_PRIVACY_UNDECLARED: NSPrivacyAccessedAPICategoryFileTimestamp (_fstat)',
    )
  })
})

const PROJECT = 'src-tauri/gen/apple/devot.xcodeproj/project.pbxproj'

// The Tauri CLI starts xcodebuild with only its own variables (TAURI_*, CARGO_*, RUST_*), so the
// App Store switches reach Xcode, and through its Run Script phase cargo, as build settings.
describe('the App Store build settings', () => {
  it("sets the markers and the iCloud switch in both of the iPhone app's configurations", () => {
    const project = withAppStoreSettings(readFileSync(PROJECT, 'utf8'))
    for (const setting of [
      'DEVOT_DISTRIBUTION = "app-store";',
      'DEVOT_ICLOUD = "YES";',
      'DEVOT_RELEASE_BUILD = "1";',
    ])
      expect({ setting, count: project.split(`\t\t\t\t${setting}\n`).length - 1 }).toEqual({
        setting,
        count: 2,
      })
    expect(project).not.toContain('DEVOT_SENTRY_DSN')
  })

  it("passes the crash reporter's DSN when there is one, quoted", () => {
    const project = withAppStoreSettings(readFileSync(PROJECT, 'utf8'), {
      DEVOT_SENTRY_DSN: 'https://key@o1.ingest.example/2',
    })
    expect(
      project.split('\t\t\t\tDEVOT_SENTRY_DSN = "https://key@o1.ingest.example/2";\n'),
    ).toHaveLength(3)
  })

  it('refuses a project it cannot place them in, or that sets them already', () => {
    expect(() => withAppStoreSettings('// !$*UTF8*$!\n{}')).toThrow(/^E_APP_STORE_PROJECT/)
    const once = withAppStoreSettings(readFileSync(PROJECT, 'utf8'))
    expect(() => withAppStoreSettings(once)).toThrow(/^E_APP_STORE_PROJECT: .*DEVOT_DISTRIBUTION/)
  })

  it('writes them into the project file it is given', () => {
    const dir = tempDir('devot-app-store-project-')
    const copy = join(dir, 'project.pbxproj')
    writeFileSync(copy, readFileSync(PROJECT, 'utf8'))
    const result = spawnSync(process.execPath, [script, 'project-settings', copy], {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', DEVOT_SENTRY_DSN: '' },
    })
    expect(result.status).toBe(0)
    expect(readFileSync(copy, 'utf8')).toContain('DEVOT_DISTRIBUTION = "app-store";')
    expect(readFileSync(copy, 'utf8')).not.toContain('DEVOT_SENTRY_DSN')
  })
})

// The owner's development build (docs/releasing.md, The iPhone app) has iCloud but stays a
// development build: no release or App Store marker.
describe('the iCloud build setting', () => {
  it("sets only the iCloud switch, in both of the iPhone app's configurations", () => {
    const original = readFileSync(PROJECT, 'utf8')
    const project = withICloudSettings(original)
    expect(project.split('\t\t\t\tDEVOT_ICLOUD = "YES";\n')).toHaveLength(3)
    expect(project.replaceAll('\t\t\t\tDEVOT_ICLOUD = "YES";\n', '')).toBe(original)
    expect(() => withICloudSettings(project)).toThrow(/^E_APP_STORE_PROJECT: .*DEVOT_ICLOUD/)
  })

  it('writes it into the project file it is given', () => {
    const dir = tempDir('devot-icloud-project-')
    const copy = join(dir, 'project.pbxproj')
    writeFileSync(copy, readFileSync(PROJECT, 'utf8'))
    const result = run('icloud-settings', copy)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('Set DEVOT_ICLOUD for the iPhone app.\n')
    expect(readFileSync(copy, 'utf8')).toContain('DEVOT_ICLOUD = "YES";')
    expect(readFileSync(copy, 'utf8')).not.toContain('DEVOT_DISTRIBUTION')
  })
})

// rustc lists each environment variable a crate read at compile time in its dep-info, with the value.
describe('the markers the Rust build saw', () => {
  const depInfo = (...lines: string[]) =>
    ['/w/target/release/deps/app-1.d: src/lib.rs', '', ...lines.map((l) => `# env-dep:${l}`)].join(
      '\n',
    )

  it('passes when the crate read the release marker and the App Store marker', () => {
    expect(
      markerProblems([depInfo('DEVOT_RELEASE_BUILD=1', 'DEVOT_DISTRIBUTION=app-store'), depInfo()]),
    ).toEqual([])
  })

  it('names a marker the build did not see, or saw with another value', () => {
    expect(
      markerProblems([depInfo('DEVOT_RELEASE_BUILD', 'DEVOT_DISTRIBUTION=app-store')]),
    ).toEqual(['E_APP_STORE_MARKER: the Rust build read DEVOT_RELEASE_BUILD unset, not 1'])
    expect(markerProblems([depInfo('DEVOT_RELEASE_BUILD=1')])).toEqual([
      'E_APP_STORE_MARKER: no crate of the Rust build read DEVOT_DISTRIBUTION',
    ])
    expect(
      markerProblems([
        depInfo('DEVOT_RELEASE_BUILD=1', 'DEVOT_DISTRIBUTION=app-store'),
        depInfo('DEVOT_DISTRIBUTION'),
      ]),
    ).toEqual(['E_APP_STORE_MARKER: the Rust build read DEVOT_DISTRIBUTION unset, not app-store'])
  })

  it('checks the dep-info files of a build folder', () => {
    const deps = join(tempDir('devot-app-store-deps-'), 'deps')
    mkdirSync(deps)
    writeFileSync(
      join(deps, 'app-1.d'),
      depInfo('DEVOT_RELEASE_BUILD=1', 'DEVOT_DISTRIBUTION=app-store'),
    )
    writeFileSync(join(deps, 'app-1.rlib'), 'DEVOT_DISTRIBUTION')
    expect(run('marker-check', deps).status).toBe(0)
    writeFileSync(join(deps, 'other-2.d'), depInfo('DEVOT_DISTRIBUTION'))
    const failed = run('marker-check', deps)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain(
      '::error::E_APP_STORE_MARKER: the Rust build read DEVOT_DISTRIBUTION unset',
    )
  })
})
