import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// Ad-hoc signatures carry entitlements as a Developer ID one does, so no identity is needed here.
// codesign keeps entitlements off a dylib by itself, so the other Mach-O is a helper executable.
const SCRIPT = 'scripts/release/macos-entitlements.sh'
const ENTITLEMENTS = 'tests/fixtures/signing/test.entitlements'

let app = ''
let helper = ''

function sign(path: string, entitlements?: string) {
  execFileSync('codesign', [
    '--force',
    '--sign',
    '-',
    '--options',
    'runtime',
    ...(entitlements ? ['--entitlements', entitlements] : []),
    path,
  ])
}

function entitlementsFile(edit: (plist: string) => string): string {
  const path = join(tempDir('devot-entitlements-'), 'edited.entitlements')
  writeFileSync(path, edit(readFileSync(ENTITLEMENTS, 'utf8')))
  return path
}

function check(...args: string[]) {
  const result = spawnSync(SCRIPT, [app, ...args], {
    env: { PATH: process.env['PATH'] ?? '' },
    encoding: 'utf8',
  })
  return { status: result.status, output: result.stdout + result.stderr }
}

function signed(main: string | undefined, other?: string) {
  sign(helper, other)
  sign(app, main)
}

describe.skipIf(process.platform !== 'darwin')('the entitlements check', () => {
  beforeAll(() => {
    const dir = tempDir('devot-entitlements-app-')
    app = join(dir, 'Devot.app')
    const contents = join(app, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, 'Frameworks'))
    writeFileSync(join(dir, 'main.c'), 'int main(void) { return 0; }\n')
    execFileSync('cc', ['-o', join(contents, 'MacOS', 'devot'), join(dir, 'main.c')])
    helper = join(contents, 'Frameworks', 'helper')
    execFileSync('cc', ['-o', helper, join(dir, 'main.c')])
    writeFileSync(
      join(contents, 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
        '<key>CFBundleExecutable</key><string>devot</string>' +
        '<key>CFBundleIdentifier</key><string>io.github.jma49.devot.signtest</string>' +
        '</dict></plist>\n',
    )
  })

  it('accepts exactly the set on the main executable and none elsewhere', () => {
    signed(ENTITLEMENTS)
    expect(check(ENTITLEMENTS)).toEqual({ status: 0, output: '' })
  })

  it('refuses a main executable with an extra or a missing entitlement', () => {
    const extra = entitlementsFile((plist) =>
      plist.replace(
        '<dict>\n',
        '<dict>\n\t<key>com.apple.security.get-task-allow</key>\n\t<true/>\n',
      ),
    )
    const missing = entitlementsFile((plist) =>
      plist.replace(/\t<key>keychain-access-groups<\/key>\n\t<array>[^]*?<\/array>\n/, ''),
    )
    for (const carried of [extra, missing]) {
      signed(carried)
      const { status, output } = check(ENTITLEMENTS)
      expect(status).toBe(1)
      expect(output).toContain(
        '::error::E_SIGN_ENTITLEMENTS: Devot.app does not carry exactly the entitlements in test.entitlements',
      )
    }
  })

  it('refuses entitlements on any other Mach-O', () => {
    signed(ENTITLEMENTS, ENTITLEMENTS)
    const { status, output } = check(ENTITLEMENTS)
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_ENTITLEMENTS: Devot.app/Contents/Frameworks/helper carries entitlements; only the main executable may',
    )
  })

  it('without the profile, accepts no entitlements and refuses any on the main executable', () => {
    signed(undefined)
    expect(check()).toEqual({ status: 0, output: '' })
    signed(ENTITLEMENTS)
    const { status, output } = check()
    expect(status).toBe(1)
    expect(output).toContain(
      '::error::E_SIGN_ENTITLEMENTS: Devot.app/Contents/MacOS/devot carries entitlements; a build without the provisioning profile has none',
    )
  })
})
