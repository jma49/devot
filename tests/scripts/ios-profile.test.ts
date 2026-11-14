import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  certificateSha1,
  fixtureCertificate,
  fixtureProfile,
} from '../support/provisioning-profile'
import { tempDir } from '../support/temp-dirs'

const SCRIPT = 'scripts/release/ios-profile.sh'
const TEAM = 'TESTTEAM01'
const BUNDLE = 'io.github.jma49.devot.signtest'

/** The fixture profile reshaped as an App Store profile for the iPhone app. */
function appStore(plist: string): string {
  return plist
    .replace('<string>OSX</string>', '<string>iOS</string>')
    .replace('\t<key>ProvisionsAllDevices</key>\n\t<true/>\n', '')
    .replace('<key>com.apple.application-identifier</key>', '<key>application-identifier</key>')
    .replace('<key>com.apple.developer.aps-environment</key>', '<key>aps-environment</key>')
    .replace(
      '\t\t<key>keychain-access-groups</key>',
      '\t\t<key>beta-reports-active</key>\n\t\t<true/>\n\t\t<key>get-task-allow</key>\n\t\t<false/>\n' +
        `\t\t<key>com.apple.security.application-groups</key>\n\t\t<array>\n\t\t\t<string>group.${BUNDLE}</string>\n\t\t</array>\n` +
        '\t\t<key>keychain-access-groups</key>',
    )
}

/** What ios-export.sh signs the app with: the iPhone app's entitlements file, with its App ID, team and push environment. */
function signingEntitlements(): string {
  const file = readFileSync('src-tauri/gen/apple/devot_iOS/devot_iOS.entitlements', 'utf8')
    .replaceAll('WMG3HG38DV', TEAM)
    .replaceAll('io.github.jma49.devot', BUNDLE)
    .replace('<string>development</string>', '<string>production</string>')
    .replace(
      '<dict>\n',
      `<dict>\n\t<key>application-identifier</key>\n\t<string>${TEAM}.${BUNDLE}</string>\n\t<key>com.apple.developer.team-identifier</key>\n\t<string>${TEAM}</string>\n\t<key>com.apple.developer.icloud-container-environment</key>\n\t<string>Production</string>\n`,
    )
  const path = join(tempDir('devot-ios-entitlements-'), 'signing.entitlements')
  writeFileSync(path, file)
  return path
}

function check(profile: string, entitlements = signingEntitlements()) {
  const result = spawnSync(
    SCRIPT,
    [profile, entitlements, TEAM, BUNDLE, certificateSha1(fixtureCertificate())],
    {
      env: { PATH: process.env['PATH'] ?? '', RUNNER_TEMP: tempDir('devot-ios-profile-run-') },
      encoding: 'utf8',
    },
  )
  return { status: result.status, output: result.stdout + result.stderr }
}

describe.skipIf(process.platform !== 'darwin')('the App Store provisioning profile check', () => {
  it('accepts an App Store profile of the team and App ID that grants the signing entitlements', () => {
    const { status, output } = check(fixtureProfile({ edit: appStore }))
    expect(output).toMatch(
      /^App Store provisioning profile for TESTTEAM01\.io\.github\.jma49\.devot\.signtest: valid until \d{4}-/m,
    )
    expect(status).toBe(0)
  })

  it('refuses the Mac profile', () => {
    expect(check(fixtureProfile()).output).toContain('::error::E_SIGN_PROFILE_PLATFORM')
  })

  it('refuses a development, ad hoc or enterprise profile', () => {
    for (const edit of [
      (plist: string) =>
        appStore(plist).replace(
          '\t<key>TeamIdentifier</key>',
          '\t<key>ProvisionedDevices</key>\n\t<array>\n\t\t<string>00008110-000000000000001E</string>\n\t</array>\n\t<key>TeamIdentifier</key>',
        ),
      (plist: string) =>
        appStore(plist).replace(
          '\t<key>TeamIdentifier</key>',
          '\t<key>ProvisionsAllDevices</key>\n\t<true/>\n\t<key>TeamIdentifier</key>',
        ),
      (plist: string) =>
        appStore(plist).replace(
          '<key>get-task-allow</key>\n\t\t<false/>',
          '<key>get-task-allow</key>\n\t\t<true/>',
        ),
    ]) {
      const { status, output } = check(fixtureProfile({ edit }))
      expect(status).toBe(1)
      expect(output).toContain('::error::E_SIGN_PROFILE_NOT_APP_STORE')
    }
  })

  it('refuses a profile of another team or App ID, or without the certificate', () => {
    const team = fixtureProfile({
      edit: (plist) =>
        appStore(plist).replace(
          `<array>\n\t\t<string>${TEAM}</string>`,
          '<array>\n\t\t<string>OTHERTEAM1</string>',
        ),
    })
    expect(check(team).output).toContain('::error::E_SIGN_PROFILE_TEAM')
    const appId = fixtureProfile({
      edit: (plist) =>
        appStore(plist).replace(`${TEAM}.${BUNDLE}<`, `${TEAM}.io.github.jma49.other<`),
    })
    expect(check(appId).output).toContain(
      `::error::E_SIGN_PROFILE_APP_ID: the provisioning profile is for ${TEAM}.io.github.jma49.other, not ${TEAM}.${BUNDLE}`,
    )
    const other = Buffer.from('another certificate').toString('base64')
    expect(check(fixtureProfile({ edit: appStore, certificates: [other] })).output).toContain(
      '::error::E_SIGN_PROFILE_CERTIFICATE',
    )
  })

  it('names what the profile does not grant, such as iCloud or the push environment', () => {
    const development = fixtureProfile({
      edit: (plist) =>
        appStore(plist).replace('<string>production</string>', '<string>development</string>'),
    })
    expect(check(development).output).toMatch(
      /E_SIGN_PROFILE_ENTITLEMENTS: the provisioning profile does not grant aps-environment;/,
    )
    const noCloud = fixtureProfile({
      edit: (plist) =>
        appStore(plist).replace(
          /\t\t<key>com\.apple\.developer\.icloud-container-identifiers<\/key>\n\t\t<array>\n[^]*?<\/array>\n/,
          '',
        ),
    })
    expect(check(noCloud).output).toContain(
      'does not grant com.apple.developer.icloud-container-identifiers;',
    )
  })

  it('refuses a profile that ends within 30 days', () => {
    const { status, output } = check(fixtureProfile({ edit: appStore, expiresInDays: 10 }))
    expect(status).toBe(1)
    expect(output).toContain('::error::E_SIGN_PROFILE_EXPIRING')
  })
})
