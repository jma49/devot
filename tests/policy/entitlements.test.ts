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
  'com.apple.developer.icloud-container-environment': 'Production',
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
      ...ICLOUD,
    })
  })

  // Xcode takes the App ID and team from the profile, and sets aps-environment to the App Store
  // profile's value when it exports for the App Store.
  it('give the iPhone app the same container, keychain group and push', () => {
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

describe("the iPhone app's container in Info.plist", () => {
  // B3 reads it to tell a build signed with the container from one that is not (ADR 0015).
  it('is set only when the build is signed, in the project and in the spec it is generated from', () => {
    expect(readFileSync(`${APPLE}/devot_iOS/Info.plist`, 'utf8')).toMatch(
      /<key>DevotCloudKitContainer<\/key>\n\t<string>\$\(DEVOT_CLOUDKIT_CONTAINER\)<\/string>/,
    )
    const project = readFileSync(`${APPLE}/devot.xcodeproj/project.pbxproj`, 'utf8')
    expect(
      project.match(
        /DEVOT_CLOUDKIT_CONTAINER = "\$\(DEVOT_CLOUDKIT_CONTAINER_SIGNED_\$\(CODE_SIGNING_ALLOWED\)\)";/g,
      ),
    ).toHaveLength(2)
    expect(
      project.match(new RegExp(`DEVOT_CLOUDKIT_CONTAINER_SIGNED_YES = ${CONTAINER};`, 'g')),
    ).toHaveLength(2)
    expect(project).not.toMatch(/DEVOT_CLOUDKIT_CONTAINER_SIGNED_NO/)

    const spec = readFileSync(`${APPLE}/project.yml`, 'utf8')
    expect(spec).toContain('DevotCloudKitContainer: $(DEVOT_CLOUDKIT_CONTAINER)')
    expect(spec).toContain(
      'DEVOT_CLOUDKIT_CONTAINER: $(DEVOT_CLOUDKIT_CONTAINER_SIGNED_$(CODE_SIGNING_ALLOWED))',
    )
    expect(spec).toContain(`DEVOT_CLOUDKIT_CONTAINER_SIGNED_YES: ${CONTAINER}`)
  })
})
