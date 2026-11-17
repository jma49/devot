import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TEAM = 'WMG3HG38DV'
const CONTAINER = 'iCloud.io.github.jma49.devot'
const KEYCHAIN_GROUP = `${TEAM}.io.github.jma49.devot`
const MAC = 'src-tauri/macos/Devot.entitlements'
const IOS = 'src-tauri/gen/apple/devot_iOS/devot_iOS.entitlements'
const APPLE = 'src-tauri/gen/apple'

type Value = string | boolean | string[]

/** The top-level dict of an entitlements plist; a value that is not a string, boolean or string array throws. */
function parseEntitlements(text: string, label = 'plist'): Record<string, Value> {
  const body = /<plist[^>]*>\s*<dict>([^]*)<\/dict>\s*<\/plist>/.exec(text)?.[1]
  if (body === undefined) throw new Error(`E_TEST_NOT_A_PLIST ${label}`)
  const result: Record<string, Value> = {}
  const keys = [...body.matchAll(/<key>([^<]+)<\/key>/g)]
  for (const [i, match] of keys.entries()) {
    const key = match[1]!
    const rest = body.slice(match.index + match[0].length, keys[i + 1]?.index ?? body.length)
    const value =
      /^\s*<string>([^<]*)<\/string>\s*$/.exec(rest)?.[1] ??
      (/^\s*<true\/>\s*$/.test(rest) ? true : /^\s*<false\/>\s*$/.test(rest) ? false : undefined)
    const array = /^\s*<array>([^]*?)<\/array>\s*$/.exec(rest)?.[1]
    const items = array === undefined ? null : array.replaceAll(/<string>[^<]*<\/string>/g, '')
    if (value !== undefined) result[key] = value
    else if (array !== undefined && items?.trim() === '')
      result[key] = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!)
    else throw new Error(`E_TEST_PLIST_VALUE ${key}`)
  }
  return result
}

const entitlements = (path: string) => parseEntitlements(readFileSync(path, 'utf8'), path)

const ICLOUD = {
  'com.apple.developer.icloud-container-identifiers': [CONTAINER],
  'com.apple.developer.icloud-services': ['CloudKit'],
  'keychain-access-groups': [KEYCHAIN_GROUP],
}
const SHARE = 'src-tauri/gen/apple/devot_Share/devot_Share.entitlements'
const INTENTS = 'src-tauri/gen/apple/devot_Intents/devot_Intents.entitlements'
const WIDGET = 'src-tauri/gen/apple/devot_Widget/devot_Widget.entitlements'
const IOS_LOCAL = 'src-tauri/gen/apple/devot_iOS/devot_iOS-local.entitlements'
const APP_GROUP = { 'com.apple.security.application-groups': ['group.io.github.jma49.devot'] }

const plist = (dict: string) =>
  `<?xml version="1.0"?><plist version="1.0"><dict>${dict}</dict></plist>`

describe('the entitlements parser', () => {
  it('reads booleans and throws on a value it cannot read', () => {
    expect(
      parseEntitlements(plist('<key>get-task-allow</key><true/><key>x</key><string>y</string>')),
    ).toEqual({ 'get-task-allow': true, x: 'y' })
    expect(() =>
      parseEntitlements(plist('<key>nested</key><dict><key>a</key><true/></dict>')),
    ).toThrow('E_TEST_PLIST_VALUE nested')
  })
})

describe('the entitlements', () => {
  it('give the Mac app exactly its App ID, team, CloudKit in Production, push and the keychain group', () => {
    expect(entitlements(MAC)).toEqual({
      'com.apple.application-identifier': `${TEAM}.io.github.jma49.devot`,
      'com.apple.developer.team-identifier': TEAM,
      'com.apple.developer.aps-environment': 'production',
      'com.apple.developer.icloud-container-environment': 'Production',
      ...ICLOUD,
    })
  })

  // Xcode takes the App ID and team from the profile, and sets aps-environment to the App Store
  // profile's value when it exports for the App Store. With no container environment a
  // development-signed build uses Development; ExportOptions.plist asks for Production.
  it('give the iPhone app the same container, keychain group and push, in the environment its profile gives', () => {
    expect(entitlements(IOS)).toEqual({ 'aps-environment': 'development', ...ICLOUD, ...APP_GROUP })
  })

  // The Share Extension's inbox (docs/specs/share-extension.md) is the one thing the two share.
  it('give the extensions the App Group alone, and the app the App Group in every build', () => {
    expect(entitlements(SHARE)).toEqual(APP_GROUP)
    expect(entitlements(INTENTS)).toEqual(APP_GROUP)
    // The widget and Control only open the app, so they hold nothing, not even the inbox.
    expect(entitlements(WIDGET)).toEqual({})
    expect(entitlements(IOS_LOCAL)).toEqual(APP_GROUP)
    expect(readFileSync(`${APPLE}/project.yml`, 'utf8')).toContain(
      'DEVOT_ENTITLEMENTS_: devot_iOS/devot_iOS-local.entitlements',
    )
    const exporter = readFileSync('scripts/release/ios-export.sh', 'utf8')
    expect(exporter).toContain(
      'share) variable=APPLE_PROVISIONING_PROFILE_SHARE target=devot_Share ;;',
    )
    expect(exporter).toContain(
      'intents) variable=APPLE_PROVISIONING_PROFILE_INTENTS target=devot_Intents ;;',
    )
    expect(exporter).toContain(
      'widget) variable=APPLE_PROVISIONING_PROFILE_WIDGET target=devot_Widget ;;',
    )
    expect(exporter).toContain('src-tauri/gen/apple/$target/$target.entitlements')
  })

  it('reach the Mac app only through the signing script: the ad-hoc build carries none', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as {
      bundle: { macOS: Record<string, unknown> }
    }
    expect(config.bundle.macOS).not.toHaveProperty('entitlements')
    expect(readFileSync('.github/workflows/release.yml', 'utf8')).toContain(
      `--entitlements ${MAC} `,
    )
  })

  it('have a test copy for the signing tests that differs only in team and App ID', () => {
    const fixture = readFileSync('tests/fixtures/signing/test.entitlements', 'utf8')
    expect(fixture).toBe(
      readFileSync(MAC, 'utf8')
        .replaceAll(TEAM, 'TESTTEAM01')
        .replaceAll('io.github.jma49.devot', 'io.github.jma49.devot.signtest'),
    )
  })
})

describe("the iPhone app's iCloud switch", () => {
  // B3 reads the container from Info.plist to tell a build that may touch CloudKit (ADR 0015).
  it('gives the build its entitlements and the container in Info.plist only with DEVOT_ICLOUD=YES', () => {
    expect(readFileSync(`${APPLE}/devot_iOS/Info.plist`, 'utf8')).toMatch(
      /<key>DevotCloudKitContainer<\/key>\n\t<string>\$\(DEVOT_CLOUDKIT_CONTAINER\)<\/string>/,
    )
    const project = readFileSync(`${APPLE}/devot.xcodeproj/project.pbxproj`, 'utf8')
    for (const setting of [
      'CODE_SIGN_ENTITLEMENTS = "$(DEVOT_ENTITLEMENTS_$(DEVOT_ICLOUD))";',
      'DEVOT_CLOUDKIT_CONTAINER = "$(DEVOT_CLOUDKIT_CONTAINER_$(DEVOT_ICLOUD))";',
      `DEVOT_CLOUDKIT_CONTAINER_YES = ${CONTAINER};`,
      'DEVOT_ENTITLEMENTS_YES = devot_iOS/devot_iOS.entitlements;',
    ])
      expect({ setting, count: project.split(setting).length - 1 }).toEqual({ setting, count: 2 })
    // The app's two configurations, then each extension's, which carry no iCloud.
    expect(project.match(/CODE_SIGN_ENTITLEMENTS = /g)).toHaveLength(8)
    for (const target of ['devot_Share', 'devot_Intents', 'devot_Widget']) {
      expect(
        project.match(
          new RegExp(`CODE_SIGN_ENTITLEMENTS = ${target}/${target}.entitlements;`, 'g'),
        ),
      ).toHaveLength(2)
    }

    const spec = readFileSync(`${APPLE}/project.yml`, 'utf8')
    for (const setting of [
      'DevotCloudKitContainer: $(DEVOT_CLOUDKIT_CONTAINER)',
      'CODE_SIGN_ENTITLEMENTS: $(DEVOT_ENTITLEMENTS_$(DEVOT_ICLOUD))',
      'DEVOT_CLOUDKIT_CONTAINER: $(DEVOT_CLOUDKIT_CONTAINER_$(DEVOT_ICLOUD))',
      `DEVOT_CLOUDKIT_CONTAINER_YES: ${CONTAINER}`,
      'DEVOT_ENTITLEMENTS_YES: devot_iOS/devot_iOS.entitlements',
    ])
      expect(spec).toContain(setting)
    expect(spec).not.toMatch(/^\s*entitlements:/m)

    // Only the build that ships passes the switch, so local, CI and fork builds have no container.
    for (const file of [project, spec, readFileSync('.github/workflows/ci.yml', 'utf8')]) {
      expect(file).not.toMatch(/^\s*DEVOT_ICLOUD\s*[:=]/m)
      expect(file).not.toContain('CODE_SIGNING_ALLOWED')
    }
    // The App Store build ships: it sets the switch as a build setting (app-store.ts project-settings).
    expect(readFileSync('.github/workflows/app-store.yml', 'utf8')).toContain(
      'node scripts/release/app-store.ts project-settings',
    )
    expect(readFileSync('scripts/release/app-store.ts', 'utf8')).toContain("DEVOT_ICLOUD: 'YES',")
  })
})
