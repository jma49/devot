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

const SCRIPT = 'scripts/release/macos-profile.sh'
const ENTITLEMENTS = 'tests/fixtures/signing/test.entitlements'
const TEAM = 'TESTTEAM01'
const BUNDLE = 'io.github.jma49.devot.signtest'

function check(
  profile: string,
  entitlements = ENTITLEMENTS,
  team = TEAM,
  bundle = BUNDLE,
  certificate = certificateSha1(fixtureCertificate()),
) {
  const result = spawnSync(SCRIPT, [profile, entitlements, team, bundle, certificate], {
    env: { PATH: process.env['PATH'] ?? '', RUNNER_TEMP: tempDir('devot-profile-run-') },
    encoding: 'utf8',
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

function without(key: string) {
  return (plist: string) =>
    plist.replace(
      new RegExp(`\\t\\t<key>${key}</key>\\n\\t\\t<(string>[^<]*</string|array>[^]*?</array)>\\n`),
      '',
    )
}

describe.skipIf(process.platform !== 'darwin')('the provisioning profile check', () => {
  it('accepts a profile of the team and App ID that grants every entitlement, wildcards included', () => {
    const { status, output } = check(fixtureProfile({ expiresInDays: 60 }))
    expect(output).toMatch(
      /^Provisioning profile for TESTTEAM01\.io\.github\.jma49\.devot\.signtest: valid until \d{4}-/m,
    )
    expect(status).toBe(0)
    expect(output).not.toContain('DeveloperCertificates')
  })

  it('accepts the checked-in entitlements against a profile shaped like the Developer ID one', () => {
    const profile = fixtureProfile({
      edit: (plist) => plist.replaceAll(TEAM, 'WMG3HG38DV').replaceAll('devot.signtest', 'devot'),
    })
    const { status, output } = check(
      profile,
      'src-tauri/macos/Devot.entitlements',
      'WMG3HG38DV',
      'io.github.jma49.devot',
    )
    expect({ status, output }).toEqual({
      status: 0,
      output: expect.stringContaining('valid until'),
    })
  })

  it('refuses a profile of another team', () => {
    const profile = fixtureProfile({
      edit: (plist) =>
        plist.replace(
          `<array>\n\t\t<string>${TEAM}</string>`,
          '<array>\n\t\t<string>OTHERTEAM1</string>',
        ),
    })
    const { status, output } = check(profile)
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_PROFILE_TEAM: the provisioning profile is for team OTHERTEAM1, not TESTTEAM01',
    )
  })

  it('refuses a profile for another App ID, or entitlements that name another', () => {
    const other = fixtureProfile({
      edit: (plist) => plist.replace(`${TEAM}.${BUNDLE}<`, `${TEAM}.io.github.jma49.other<`),
    })
    expect(check(other).output).toContain(
      `::error::E_SIGN_PROFILE_APP_ID: the provisioning profile is for ${TEAM}.io.github.jma49.other, not ${TEAM}.${BUNDLE}`,
    )
    const dir = tempDir('devot-profile-app-id-')
    const elsewhere = join(dir, 'other.entitlements')
    writeFileSync(
      elsewhere,
      readFileSync(ENTITLEMENTS, 'utf8').replace(
        `${TEAM}.${BUNDLE}<`,
        `${TEAM}.io.github.jma49.other<`,
      ),
    )
    const { status, output } = check(fixtureProfile(), elsewhere)
    expect(status).toBe(1)
    expect(output).toContain(
      `::error::E_SIGN_PROFILE_APP_ID: other.entitlements does not name ${TEAM}.${BUNDLE}`,
    )
  })

  it('refuses a profile for the iPhone', () => {
    const profile = fixtureProfile({
      edit: (plist) => plist.replace('<string>OSX</string>', '<string>iOS</string>'),
    })
    expect(check(profile).output).toContain('::error::E_SIGN_PROFILE_PLATFORM')
  })

  it('refuses a profile that is not for Developer ID, such as one for the Mac App Store', () => {
    for (const edit of [
      (plist: string) => plist.replace('\t<key>ProvisionsAllDevices</key>\n\t<true/>\n', ''),
      (plist: string) =>
        plist.replace(
          '<key>ProvisionsAllDevices</key>\n\t<true/>',
          '<key>ProvisionsAllDevices</key>\n\t<false/>',
        ),
    ]) {
      const { status, output } = check(fixtureProfile({ edit }))
      expect(status).toBe(1)
      expect(output).toContain(
        '::error::E_SIGN_PROFILE_NOT_DEVELOPER_ID: the provisioning profile does not provision all devices, so it is not a Developer ID profile',
      )
    }
  })

  // A renewed Developer ID certificate needs a new profile: macOS kills an app whose profile
  // does not list the certificate that signed it.
  it('accepts a profile only when it holds the signing certificate', () => {
    const other = Buffer.from('another certificate').toString('base64')
    const both = fixtureProfile({ certificates: [other, fixtureCertificate()] })
    expect(check(both).status).toBe(0)

    const { status, output } = check(fixtureProfile({ certificates: [other] }))
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_PROFILE_CERTIFICATE: the provisioning profile does not hold the signing certificate; make a new one with the current Developer ID certificate (docs/releasing.md, Signing the app)',
    )
    expect(output).not.toContain(certificateSha1(other))
    expect(check(fixtureProfile({ certificates: [] })).output).toContain(
      '::error::E_SIGN_PROFILE_CERTIFICATE',
    )
  })

  it('needs the signing certificate as a SHA-1', () => {
    for (const certificate of [
      '',
      'not-a-hash',
      certificateSha1(fixtureCertificate()).toLowerCase(),
    ]) {
      const { status, output } = check(fixtureProfile(), ENTITLEMENTS, TEAM, BUNDLE, certificate)
      expect({ certificate, status }).toEqual({ certificate, status: 1 })
      expect(output).toContain('::error::E_SIGN_USAGE')
    }
  })

  it('names each entitlement the profile does not grant', () => {
    const lacking = fixtureProfile({
      edit: (plist) =>
        without('keychain-access-groups')(plist).replace(
          '<string>iCloud.io.github.jma49.devot.signtest</string>\n\t\t</array>\n\t\t<key>com.apple.developer.icloud-services',
          '<string>iCloud.io.github.jma49.other</string>\n\t\t</array>\n\t\t<key>com.apple.developer.icloud-services',
        ),
    })
    const { status, output } = check(lacking)
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_PROFILE_ENTITLEMENTS: the provisioning profile does not grant com.apple.developer.icloud-container-identifiers keychain-access-groups;',
    )

    const otherGroup = fixtureProfile({
      edit: (plist) => plist.replace(`<string>${TEAM}.*</string>`, '<string>OTHERTEAM1.*</string>'),
    })
    expect(check(otherGroup).output).toMatch(
      /E_SIGN_PROFILE_ENTITLEMENTS: .* grant keychain-access-groups;/,
    )

    const development = fixtureProfile({
      edit: (plist) => plist.replace('<string>production</string>', '<string>development</string>'),
    })
    expect(check(development).output).toMatch(
      /E_SIGN_PROFILE_ENTITLEMENTS: .* grant com\.apple\.developer\.aps-environment;/,
    )
  })

  it('refuses entitlements beyond the profile, such as one it never grants', () => {
    const dir = tempDir('devot-profile-entitlements-')
    const extra = join(dir, 'extra.entitlements')
    writeFileSync(
      extra,
      readFileSync(ENTITLEMENTS, 'utf8').replace(
        '<dict>\n',
        '<dict>\n\t<key>com.apple.security.cs.disable-library-validation</key>\n\t<true/>\n',
      ),
    )
    expect(check(fixtureProfile(), extra).output).toContain(
      'does not grant com.apple.security.cs.disable-library-validation;',
    )
  })

  it('fails a release whose profile ends within 30 days, or has ended', () => {
    for (const days of [29, -1]) {
      const { status, output } = check(fixtureProfile({ expiresInDays: days }))
      expect({ days, status }).toEqual({ days, status: 1 })
      expect(output).toMatch(
        /::error::E_SIGN_PROFILE_EXPIRING: the provisioning profile ends on \S+, in fewer than 30 days/,
      )
    }
    expect(check(fixtureProfile({ expiresInDays: 31 })).status).toBe(0)
  })

  it('refuses a file that is not a signed profile', () => {
    const dir = tempDir('devot-profile-junk-')
    writeFileSync(join(dir, 'junk.provisionprofile'), 'not a profile')
    const { status, output } = check(join(dir, 'junk.provisionprofile'))
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_PROFILE_UNREADABLE: the provisioning profile is not a signed property list',
    )
  })
})
