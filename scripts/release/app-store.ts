// The App Store workflow's checks (.github/workflows/app-store.yml, docs/releasing.md, The App
// Store build):
//
//   node scripts/release/app-store.ts version <version> <run number> <run attempt>
//     Prints `short=MAJOR.MINOR.PATCH` (CFBundleShortVersionString, the release version without
//     its beta) and `build=<run number>.<run attempt>` (CFBundleVersion, which App Store Connect
//     needs to grow with every upload) for $GITHUB_OUTPUT.
//
//   node scripts/release/app-store.ts project-settings <project.pbxproj>
//     Writes the App Store build's switches into the iPhone app's build settings, and
//     DEVOT_SENTRY_DSN when the environment has one. The Tauri CLI starts xcodebuild with only its
//     own variables, so these reach Xcode, and the Rust build through Xcode's Run Script phase,
//     only as build settings.
//
//   node scripts/release/app-store.ts marker-check <target>/aarch64-apple-ios/release/deps
//     Checks from rustc's dep-info that the Rust build read DEVOT_RELEASE_BUILD=1 and
//     DEVOT_DISTRIBUTION=app-store.
//
//   node scripts/release/app-store.ts check-bundle <Info.plist as JSON> <short> <build>
//     Checks the archived app is the iPhone-only App Store build with iCloud and that version.
//
//   node scripts/release/app-store.ts privacy-check <PrivacyInfo.xcprivacy as JSON> <nm -u output> <otool -v -s output>
//     Finds the required-reason APIs the binary calls (App Store Connect refuses an upload that
//     calls one its privacy manifest gives no reason for) and checks the manifest gives each a reason.
//
// Errors are GitHub annotations with a code and end the run with status 1.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const config = new URL('../../src-tauri/tauri.conf.json', import.meta.url)
const BUNDLE_ID = (JSON.parse(readFileSync(config, 'utf8')) as { identifier: string }).identifier
const CONTAINER = `iCloud.${BUNDLE_ID}`
const VERSION = /^(\d+\.\d+\.\d+)(?:-beta\.?[1-9]\d*)?$/
const COUNTER = /^[1-9]\d*$/

export function appStoreVersion(version: string, runNumber: string, runAttempt: string) {
  const short = VERSION.exec(version)?.[1]
  if (!short)
    throw new Error(`E_APP_STORE_VERSION: ${JSON.stringify(version)} is not a release version`)
  if (!COUNTER.test(runNumber) || !COUNTER.test(runAttempt)) {
    throw new Error('E_APP_STORE_VERSION: the run number and attempt must be counts from 1')
  }
  return { short, build: `${runNumber}.${runAttempt}` }
}

export function bundleProblems(
  info: Record<string, unknown>,
  expected: { short: string; build: string },
): string[] {
  const problems: string[] = []
  const shown = (value: unknown) => JSON.stringify(value) ?? 'not set'
  if (info['CFBundleIdentifier'] !== BUNDLE_ID) {
    problems.push(
      `E_APP_STORE_BUNDLE_ID: CFBundleIdentifier is ${shown(info['CFBundleIdentifier'])}, not ${BUNDLE_ID}`,
    )
  }
  const family = info['UIDeviceFamily']
  if (!Array.isArray(family) || family.length !== 1 || family[0] !== 1) {
    problems.push(
      `E_APP_STORE_DEVICE_FAMILY: UIDeviceFamily is ${shown(family)}, not iPhone only ([1])`,
    )
  }
  if (typeof info['ITSAppUsesNonExemptEncryption'] !== 'boolean') {
    problems.push('E_APP_STORE_ENCRYPTION: ITSAppUsesNonExemptEncryption is not set')
  }
  if (info['DevotCloudKitContainer'] !== CONTAINER) {
    problems.push(
      `E_APP_STORE_ICLOUD: DevotCloudKitContainer is ${shown(info['DevotCloudKitContainer'])}, not ${CONTAINER}: the build lacks DEVOT_ICLOUD=YES`,
    )
  }
  if (info['CFBundleShortVersionString'] !== expected.short) {
    problems.push(
      `E_APP_STORE_VERSION: CFBundleShortVersionString is ${shown(info['CFBundleShortVersionString'])}, not ${expected.short}`,
    )
  }
  if (info['CFBundleVersion'] !== expected.build) {
    problems.push(
      `E_APP_STORE_BUILD_NUMBER: CFBundleVersion is ${shown(info['CFBundleVersion'])}, not ${expected.build}`,
    )
  }
  return problems
}

export const APP_STORE_SETTINGS = {
  DEVOT_RELEASE_BUILD: '1',
  DEVOT_DISTRIBUTION: 'app-store',
  DEVOT_ICLOUD: 'YES',
} as const

const SETTINGS_ANCHOR = /^(\t+)DEVOT_ENTITLEMENTS_YES = devot_iOS\/devot_iOS\.entitlements;\n/gm

/** The project with `settings` added to each of the iPhone app's two build configurations. */
export function withAppStoreSettings(project: string, extra: Record<string, string> = {}): string {
  const settings: Record<string, string> = { ...APP_STORE_SETTINGS, ...extra }
  const set = Object.keys(settings).filter((name) =>
    new RegExp(`^\\s*${name} = `, 'm').test(project),
  )
  if (set.length > 0) {
    throw new Error(`E_APP_STORE_PROJECT: the project sets ${set.join(', ')} already`)
  }
  const anchors = project.match(SETTINGS_ANCHOR)?.length ?? 0
  if (anchors !== 2) {
    throw new Error(
      `E_APP_STORE_PROJECT: the project has ${anchors} iPhone app configurations with DEVOT_ENTITLEMENTS_YES, not 2`,
    )
  }
  const quoted = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  return project.replace(SETTINGS_ANCHOR, (line, indent: string) =>
    [
      line,
      ...Object.entries(settings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${indent}${name} = ${quoted(value)};\n`),
    ].join(''),
  )
}

const MARKERS = {
  DEVOT_RELEASE_BUILD: APP_STORE_SETTINGS.DEVOT_RELEASE_BUILD,
  DEVOT_DISTRIBUTION: APP_STORE_SETTINGS.DEVOT_DISTRIBUTION,
}

/** What is wrong with the markers the crates of a build read, from their dep-info files. */
export function markerProblems(depInfos: string[]): string[] {
  const problems: string[] = []
  for (const [name, wanted] of Object.entries(MARKERS)) {
    const seen = depInfos.flatMap((info) =>
      [...info.matchAll(new RegExp(`^# env-dep:${name}(?:=(.*))?$`, 'gm'))].map((m) => m[1]),
    )
    if (seen.length === 0) {
      problems.push(`E_APP_STORE_MARKER: no crate of the Rust build read ${name}`)
      continue
    }
    for (const value of new Set(seen.filter((v) => v !== wanted))) {
      problems.push(
        `E_APP_STORE_MARKER: the Rust build read ${name} ${value === undefined ? 'unset' : `as ${JSON.stringify(value)}`}, not ${wanted}`,
      )
    }
  }
  return problems
}

/** Apple's list of APIs that need a reason (TN3183): C functions and constants by symbol, Objective-C by selector or class name. */
const REASON_APIS = {
  NSPrivacyAccessedAPICategoryFileTimestamp: [
    '_stat',
    '_fstat',
    '_fstatat',
    '_lstat',
    '_getattrlist',
    '_fgetattrlist',
    '_getattrlistat',
    '_getattrlistbulk',
    '_NSFileCreationDate',
    '_NSFileModificationDate',
    '_NSURLContentModificationDateKey',
    '_NSURLCreationDateKey',
    'creationDate',
    'modificationDate',
    'fileModificationDate',
  ],
  NSPrivacyAccessedAPICategoryDiskSpace: [
    '_statfs',
    '_statvfs',
    '_fstatfs',
    '_fstatvfs',
    '_getattrlist',
    '_fgetattrlist',
    '_getattrlistat',
    '_NSFileSystemFreeSize',
    '_NSFileSystemSize',
    '_NSURLVolumeAvailableCapacityKey',
    '_NSURLVolumeAvailableCapacityForImportantUsageKey',
    '_NSURLVolumeAvailableCapacityForOpportunisticUsageKey',
    '_NSURLVolumeTotalCapacityKey',
    'systemFreeSize',
    'systemSize',
  ],
  NSPrivacyAccessedAPICategorySystemBootTime: ['_mach_absolute_time', 'systemUptime'],
  NSPrivacyAccessedAPICategoryUserDefaults: [
    '_OBJC_CLASS_$_NSUserDefaults',
    'NSUserDefaults',
    'standardUserDefaults',
  ],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['activeInputModes'],
} as const

type Category = keyof typeof REASON_APIS

/** The strings `otool -v -s <segment> <section>` prints, one per line after its address. */
export function otoolStrings(output: string): string[] {
  return [...output.matchAll(/^[0-9a-f]{8,}\s+(.+)$/gm)].map((m) => m[1]!)
}

/** Each category the binary uses, with the names that showed it. */
export function usedReasonApis(symbols: string[], strings: string[]): Map<Category, string[]> {
  const names = new Set([...symbols.map((s) => s.trim()), ...strings])
  const used = new Map<Category, string[]>()
  for (const [category, apis] of Object.entries(REASON_APIS) as [Category, readonly string[]][]) {
    const found = apis.filter((api) => names.has(api))
    if (found.length > 0) used.set(category, found)
  }
  return used
}

export function undeclaredReasons(
  manifest: Record<string, unknown>,
  used: Map<Category, string[]>,
) {
  const declared = new Set(
    ((manifest['NSPrivacyAccessedAPITypes'] ?? []) as Record<string, unknown>[])
      .filter((entry) => ((entry['NSPrivacyAccessedAPITypeReasons'] ?? []) as unknown[]).length > 0)
      .map((entry) => entry['NSPrivacyAccessedAPIType']),
  )
  return [...used]
    .filter(([category]) => !declared.has(category))
    .map(
      ([category, found]) =>
        `E_APP_STORE_PRIVACY_UNDECLARED: ${category} (${found.join(', ')}) has no reason in PrivacyInfo.xcprivacy`,
    )
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

function main(args: string[]) {
  const [command, ...rest] = args
  if (command === 'version' && rest.length === 3) {
    const { short, build } = appStoreVersion(rest[0]!, rest[1]!, rest[2]!)
    console.log(`short=${short}\nbuild=${build}`)
    return
  }
  if (command === 'project-settings' && rest.length === 1) {
    const dsn = process.env['DEVOT_SENTRY_DSN']
    const extra = dsn ? { DEVOT_SENTRY_DSN: dsn } : {}
    writeFileSync(rest[0]!, withAppStoreSettings(readFileSync(rest[0]!, 'utf8'), extra))
    console.log(
      `Set ${[...Object.keys(APP_STORE_SETTINGS), ...Object.keys(extra)].join(', ')} for the iPhone app.`,
    )
    return
  }
  if (command === 'marker-check' && rest.length === 1) {
    const deps = rest[0]!
    const infos = readdirSync(deps)
      .filter((file) => file.endsWith('.d'))
      .map((file) => readFileSync(join(deps, file), 'utf8'))
    const problems = markerProblems(infos)
    if (problems.length > 0) throw new Error(problems.map((p) => `::error::${p}`).join('\n'))
    console.log('The Rust build read DEVOT_RELEASE_BUILD=1 and DEVOT_DISTRIBUTION=app-store.')
    return
  }
  if (command === 'check-bundle' && rest.length === 3) {
    const problems = bundleProblems(readJson(rest[0]!), { short: rest[1]!, build: rest[2]! })
    if (problems.length > 0) throw new Error(problems.map((p) => `::error::${p}`).join('\n'))
    console.log(
      `The archive is the iPhone-only App Store build ${rest[1]} (${rest[2]}) with iCloud.`,
    )
    return
  }
  if (command === 'privacy-check' && rest.length === 3) {
    const symbols = readFileSync(rest[1]!, 'utf8').split('\n').filter(Boolean)
    const used = usedReasonApis(symbols, otoolStrings(readFileSync(rest[2]!, 'utf8')))
    for (const [category, found] of used) console.log(`${category}: ${found.join(', ')}`)
    const problems = undeclaredReasons(readJson(rest[0]!), used)
    if (problems.length > 0) throw new Error(problems.map((p) => `::error::${p}`).join('\n'))
    return
  }
  throw new Error(
    '::error::E_APP_STORE_USAGE: version <version> <run number> <run attempt> | project-settings <project.pbxproj> | marker-check <deps dir> | check-bundle <info.json> <short> <build> | privacy-check <privacy.json> <symbols> <strings>',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
