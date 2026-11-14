import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { APP_STORE_SETTINGS } from '../../scripts/release/app-store'

// The App Store build of the iPhone app (docs/releasing.md, The App Store build; ADR 0014):
// iPhone only, with the App Store marker, the iCloud container and the privacy manifest, and the
// Apple credentials only where no dependency code runs.
const read = (path: string) => readFileSync(path, 'utf8')
const APPLE = 'src-tauri/gen/apple'
const PROJECT = `${APPLE}/devot.xcodeproj/project.pbxproj`
const MANIFEST = `${APPLE}/devot_iOS/PrivacyInfo.xcprivacy`
const workflow = read('.github/workflows/app-store.yml')

function jobIn(text: string, name: string): string {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\n)*)`, 'm').exec(text)
  if (!match) throw new Error(`E_TEST_NO_JOB ${name}`)
  return match[1] ?? ''
}
const job = (name: string) => jobIn(workflow, name)
const jobNames = () => [...workflow.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!)

function stepIn(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`)
  if (start < 0) throw new Error(`E_TEST_NO_STEP ${name}`)
  const end = /\n {0,6}\S/.exec(text.slice(start))
  return text.slice(start, end ? start + end.index : undefined).trimEnd()
}
const step = (name: string) => stepIn(workflow, name)

/** The `<dict>` entries of a plist array under `key`, as raw text. */
function dicts(plist: string, key: string): string[] {
  const array = new RegExp(
    `<key>${key}</key>\\s*<array>([^]*?)</array>\\s*(?:<key>|</dict>\\s*</plist>)`,
  ).exec(plist)?.[1]
  return [...(array ?? '').matchAll(/<dict>([^]*?)<\/dict>/g)].map((m) => m[1]!)
}
const value = (dict: string, key: string) =>
  new RegExp(`<key>${key}</key>\\s*<(string>([^<]*)</string|true/|false/)>`).exec(dict)?.[2] ??
  new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(dict)?.[1]
const strings = (dict: string, key: string) =>
  [
    ...(new RegExp(`<key>${key}</key>\\s*<array>([^]*?)</array>`).exec(dict)?.[1] ?? '').matchAll(
      /<string>([^<]*)<\/string>/g,
    ),
  ].map((m) => m[1])

describe('the iPhone app', () => {
  it('is iPhone only for the first App Store release', () => {
    const project = read(PROJECT)
    // The app's two configurations, then the Share Extension's.
    expect(project.match(/TARGETED_DEVICE_FAMILY = [^;]*;/g)).toEqual(
      Array(8).fill('TARGETED_DEVICE_FAMILY = 1;'),
    )
    expect(read(`${APPLE}/project.yml`)).toMatch(/^ {8}TARGETED_DEVICE_FAMILY: 1$/m)
    expect(read(`${APPLE}/project.yml`)).not.toContain('~ipad')
    expect(read(`${APPLE}/devot_iOS/Info.plist`)).not.toContain('~ipad')
  })

  it('bundles the privacy manifest in the app and in each extension', () => {
    const project = read(PROJECT)
    const resources = [
      ...project.matchAll(/isa = PBXResourcesBuildPhase;[^]*?files = \(([^)]*)\)/g),
    ]
    for (const folder of ['devot_iOS', 'devot_Share', 'devot_Intents', 'devot_Widget']) {
      expect(existsSync(`${APPLE}/${folder}/PrivacyInfo.xcprivacy`)).toBe(true)
      const group = new RegExp(
        `/\\* ${folder} \\*/ = \\{\\s*isa = PBXGroup;\\s*children = \\(([^)]*)\\)`,
      ).exec(project)?.[1]
      const ref = /(\w{24}) \/\* PrivacyInfo\.xcprivacy \*\//.exec(group ?? '')?.[1]
      expect({ folder, ref: ref !== undefined }).toEqual({ folder, ref: true })
      const build = new RegExp(
        `(\\w{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `,
      ).exec(project)?.[1]
      expect({ folder, build: build !== undefined }).toEqual({ folder, build: true })
      const phases = resources.filter(([, files]) =>
        files!.includes(`${build} /* PrivacyInfo.xcprivacy in Resources */`),
      )
      expect({ folder, phases: phases.length }).toEqual({ folder, phases: 1 })
    }
  })

  it('gives each extension a manifest that collects and tracks nothing', () => {
    for (const folder of ['devot_Share', 'devot_Intents', 'devot_Widget']) {
      const manifest = read(`${APPLE}/${folder}/PrivacyInfo.xcprivacy`)
      expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/)
      expect(manifest).toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/)
      // The widget reads no file, so it names no reason for one.
      expect({
        folder,
        timestamps: manifest.includes('NSPrivacyAccessedAPICategoryFileTimestamp'),
      }).toEqual({
        folder,
        timestamps: folder !== 'devot_Widget',
      })
    }
  })

  it('declares no tracking, and what Devot receives for the app to work, linked only where the Worker keeps it with the licence', () => {
    const manifest = read(MANIFEST)
    expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\/>/)
    expect(manifest).toMatch(/<key>NSPrivacyTrackingDomains<\/key>\s*<array\/>/)
    const collected = dicts(manifest, 'NSPrivacyCollectedDataTypes')
    expect(collected.map((dict) => value(dict, 'NSPrivacyCollectedDataType'))).toEqual([
      // The licence Worker: a purchase's signed transaction (the exchange) and a seat's random device ID.
      'NSPrivacyCollectedDataTypePurchaseHistory',
      'NSPrivacyCollectedDataTypeDeviceID',
      // Sentry, once the user turns on crash reports.
      'NSPrivacyCollectedDataTypeCrashData',
    ])
    const linked = Object.fromEntries(
      collected.map((dict) => [
        value(dict, 'NSPrivacyCollectedDataType'),
        value(dict, 'NSPrivacyCollectedDataTypeLinked'),
      ]),
    )
    expect(linked).toEqual({
      NSPrivacyCollectedDataTypePurchaseHistory: 'false',
      // A seat's device ID and label sit with the licence, whose licensee is the buyer's email.
      NSPrivacyCollectedDataTypeDeviceID: 'true',
      NSPrivacyCollectedDataTypeCrashData: 'false',
    })
    for (const dict of collected) {
      expect(value(dict, 'NSPrivacyCollectedDataTypeTracking')).toBe('false')
      expect(strings(dict, 'NSPrivacyCollectedDataTypePurposes')).toEqual([
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      ])
    }
  })

  it('gives a reason for each required-reason API the app calls', () => {
    const reasons = Object.fromEntries(
      dicts(read(MANIFEST), 'NSPrivacyAccessedAPITypes').map((dict) => [
        value(dict, 'NSPrivacyAccessedAPIType'),
        strings(dict, 'NSPrivacyAccessedAPITypeReasons'),
      ]),
    )
    expect(reasons).toEqual({
      // The app's own files: the database, attachments, backups and logs, all in its container.
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      // SQLite's locking style and atomic_file's read-only check read a volume's flags and file
      // system type with statfs, fstatfs and statvfs before writing, never its free space.
      NSPrivacyAccessedAPICategoryDiskSpace: ['E174.1'],
      // The native screens read the app's own defaults: their kill switch, then this iPhone's
      // glass and navigation settings.
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
    })
  })

  // The Tauri CLI passes xcodebuild none of the shell's other variables.
  it('documents the iCloud development build through its build settings, not the environment', () => {
    for (const doc of ['docs/releasing.md', 'docs/development.md']) {
      const text = read(doc)
      expect({ doc, env: /DEVOT_ICLOUD=YES pnpm/.test(text) }).toEqual({ doc, env: false })
      expect(text).toContain('node scripts/release/app-store.ts icloud-settings')
    }
  })

  // App Store Connect's answer for standard algorithms outside France: no documents, so no compliance code (docs/releasing.md).
  it('declares no non-exempt encryption in Info.plist', () => {
    expect(read(`${APPLE}/devot_iOS/Info.plist`)).toMatch(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\n\t<false\/>/,
    )
    expect(read(`${APPLE}/project.yml`)).toMatch(/^ {8}ITSAppUsesNonExemptEncryption: false$/m)
  })

  it('keeps the development export, and exports for the App Store with its own options', () => {
    const development = read(`${APPLE}/ExportOptions.plist`)
    expect(development).toMatch(/<key>method<\/key>\s*<string>debugging<\/string>/)
    const appStore = read(`${APPLE}/ExportOptions-AppStore.plist`)
    for (const [key, setting] of [
      ['method', '<string>app-store-connect</string>'],
      ['destination', '<string>export</string>'],
      ['signingStyle', '<string>manual</string>'],
      ['iCloudContainerEnvironment', '<string>Production</string>'],
      ['manageAppVersionAndBuildNumber', '<false/>'],
    ])
      expect(appStore).toMatch(new RegExp(`<key>${key}</key>\\s*${setting}`))
    expect(read('scripts/release/ios-export.sh')).toContain(
      'options_template=$script_dir/../../src-tauri/gen/apple/ExportOptions-AppStore.plist',
    )
  })
})

describe('the App Store workflow', () => {
  it('builds the release build with the App Store marker and iCloud, unsigned', () => {
    const settings = step('Set the App Store build settings')
    expect(settings).toContain(
      'node scripts/release/app-store.ts project-settings src-tauri/gen/apple/devot.xcodeproj/project.pbxproj',
    )
    expect(APP_STORE_SETTINGS).toEqual({
      DEVOT_RELEASE_BUILD: '1',
      DEVOT_DISTRIBUTION: 'app-store',
      DEVOT_ICLOUD: 'YES',
    })
    expect(read('src-tauri/build_env.rs')).toContain('pub const APP_STORE: &str = "app-store";')
    const archive = step('Archive the App Store build')
    expect(workflow.indexOf(settings)).toBeLessThan(workflow.indexOf(archive))
    expect(archive).toContain('pnpm tauri ios build --archive-only --no-sign --config "$config"')
    expect(archive).toContain('bundleVersion: $build')
    expect(archive).not.toMatch(/--debug|--target/)
  })

  it('checks the archive is iPhone only, with iCloud, its version and a privacy manifest for what it calls', () => {
    const check = step('Check and hand over the archive')
    expect(check).toContain('node scripts/release/app-store.ts marker-check "$deps"')
    expect(check).toContain(
      'node scripts/release/app-store.ts check-bundle "$checks/info.json" "$SHORT" "$BUILD"',
    )
    expect(check).toContain('plutil -lint "$app/PrivacyInfo.xcprivacy"')
    expect(check).toContain('nm -u "$binary"')
    expect(check).toContain('node scripts/release/app-store.ts privacy-check')
    expect(check.indexOf('privacy-check')).toBeLessThan(check.indexOf('ditto -c -k'))
    expect(read('scripts/release/ios-export.sh')).toContain(
      '[ -f "$shipped/PrivacyInfo.xcprivacy" ] || fail "E_EXPORT_PRIVACY',
    )
  })

  it('takes the build number from its run counter, so it grows with every upload', () => {
    expect(step('Set the version and the build number')).toContain(
      'node scripts/release/app-store.ts version "$version" "$GITHUB_RUN_NUMBER" "$GITHUB_RUN_ATTEMPT" >> "$GITHUB_OUTPUT"',
    )
  })

  it('signs, exports and uploads only for a tag, in the release environment', () => {
    expect(workflow).toMatch(
      /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n {2}pull_request:\n/m,
    )
    const exporting = job('export')
    expect(exporting).toMatch(/^ {4}needs: \[verify, build\]$/m)
    expect(exporting).toMatch(/^ {4}if: github\.ref_type == 'tag'$/m)
    expect(exporting).toMatch(/^ {4}environment: release$/m)
    expect(job('verify')).toMatch(/^ {4}if: github\.ref_type == 'tag'$/m)
    expect(jobNames().filter((name) => /^ {4}environment:/m.test(job(name)))).toEqual(['export'])
  })

  it('checks the same release gate as the release workflow', () => {
    const name = 'Check the merged pull request passed CI'
    expect(step(name)).toBe(stepIn(read('.github/workflows/release.yml'), name))
  })

  it('gives the Apple credentials only to the export job, which runs no dependency code', () => {
    const uses = (name: string) =>
      [...job(name).matchAll(/\b(secrets|vars)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`)
    expect(uses('export').sort()).toEqual([
      'secrets.APPLE_API_KEY_P8',
      'secrets.APPLE_DISTRIBUTION_CERTIFICATE',
      'secrets.APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD',
      'secrets.APPLE_PROVISIONING_PROFILE_IOS',
      'secrets.APPLE_PROVISIONING_PROFILE_IOS_INTENTS',
      'secrets.APPLE_PROVISIONING_PROFILE_IOS_SHARE',
      'secrets.APPLE_PROVISIONING_PROFILE_IOS_WIDGET',
      'vars.APPLE_API_ISSUER_ID',
      'vars.APPLE_API_KEY_ID',
      'vars.APP_STORE_UPLOAD',
      'vars.APP_STORE_UPLOAD',
    ])
    expect(uses('build')).toEqual(['secrets.DEVOT_SENTRY_DSN'])
    for (const name of jobNames().filter((other) => other !== 'export'))
      expect({ name, apple: job(name).match(/APPLE_/g) }).toEqual({ name, apple: null })
    const exporting = job('export')
    expect(exporting).not.toMatch(
      /\bpnpm\b|\bnpx\b|\bnpm\b|\bnode\b|\bcargo\b|(?<!src-)\btauri\b|cache:|GITHUB_TOKEN|setup-node|action-setup/,
    )
    const actions = [...exporting.matchAll(/uses: ([\w-]+\/[\w-]+)@/g)].map((m) => m[1])
    expect(new Set(actions)).toEqual(
      new Set(['actions/checkout', 'actions/download-artifact', 'actions/upload-artifact']),
    )
    expect(step('Sign, export and upload the iPhone app')).toContain(
      'scripts/release/ios-export.sh $upload src-tauri/gen/apple/devot_iOS/devot_iOS.entitlements "$archive" out',
    )
  })

  it('uploads only once the owner turns it on, and only then hands over the upload key', () => {
    const signing = step('Sign, export and upload the iPhone app')
    expect(signing).toContain(
      "APPLE_API_KEY_P8: ${{ vars.APP_STORE_UPLOAD == 'true' && secrets.APPLE_API_KEY_P8 || '' }}",
    )
    expect(signing).toMatch(
      /if \[ "\$UPLOAD" = true \]; then\n\s+upload=--upload\n\s+else\n\s+echo "::notice::/,
    )
    expect(signing).not.toMatch(/base64|mobileprovision/)
  })

  it('keeps the token out of every checkout, and reads the repository only', () => {
    const checkouts = workflow.match(
      /uses: actions\/checkout@.*\n\s+with:\n(?:\s+(?:#.*|\w[\w-]*: .*)\n)*/g,
    )
    expect(checkouts?.length).toBe(workflow.match(/uses: actions\/checkout@/g)?.length)
    for (const checkout of checkouts ?? []) expect(checkout).toContain('persist-credentials: false')
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(workflow).not.toMatch(/contents: write/)
  })
})
