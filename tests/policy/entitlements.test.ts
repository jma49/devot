import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TEAM = 'WMG3HG38DV'
const CONTAINER = 'iCloud.io.github.jma49.devot'
const KEYCHAIN_GROUP = `${TEAM}.io.github.jma49.devot`
const MAC = 'src-tauri/macos/Devot.entitlements'
const IOS = 'src-tauri/gen/apple/devot_iOS/devot_iOS.entitlements'
const APPLE = 'src-tauri/gen/apple'

/** The top-level dict of an entitlements plist, whose values are strings or string arrays. */
function entitlements(path: string): Record<string, string | string[]> {
  const body = /<plist[^>]*>\s*<dict>([^]*)<\/dict>\s*<\/plist>/.exec(
    readFileSync(path, 'utf8'),
  )?.[1]
  if (body === undefined) throw new Error(`E_TEST_NOT_A_PLIST ${path}`)
  const entries = body.matchAll(
    /<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<array>([^]*?)<\/array>)/g,
  )
  return Object.fromEntries(
    [...entries].map(([, key, text, array]) => [
      key!,
      text ?? [...array!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!),
    ]),
  )
}

const ICLOUD = {
  'com.apple.developer.icloud-container-identifiers': [CONTAINER],
  'com.apple.developer.icloud-services': ['CloudKit'],
  'keychain-access-groups': [KEYCHAIN_GROUP],
}

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
    expect(entitlements(IOS)).toEqual({ 'aps-environment': 'development', ...ICLOUD })
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
    expect(project.match(/CODE_SIGN_ENTITLEMENTS = /g)).toHaveLength(2)

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
    expect(readFileSync('.github/workflows/app-store.yml', 'utf8')).toMatch(
      /^ {10}DEVOT_ICLOUD: 'YES'$/m,
    )
  })
})
