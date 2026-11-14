import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { tempDir } from '../support/temp-dirs'

// The Mac Share menu extension: the links it builds (the fixture capture_link.rs reads too), the
// bundle scripts/release/macos-share-extension.sh makes, and how Tauri puts it into the app.
const SOURCE = 'src-tauri/macos/DevotShare'
const SCRIPT = 'scripts/release/macos-share-extension.sh'
const TIMEOUT = 120_000

function tool(file: string, args: string[], input?: string): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input })
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('the share extension in the app bundle', () => {
  const config = json('src-tauri/tauri.macos.conf.json') as {
    build: { beforeBundleCommand: string }
    bundle: { macOS: { files: Record<string, string> } }
  }
  const scripts = json('package.json')['scripts'] as Record<string, string>

  it('is built before bundling, after the debug symbols the base config uploads there', () => {
    const base = json('src-tauri/tauri.conf.json') as { build: { beforeBundleCommand: string } }
    expect(config.build.beforeBundleCommand).toBe(
      `${base.build.beforeBundleCommand} && pnpm share:mac`,
    )
    expect(scripts['share:mac']).toBe(`sh ${SCRIPT} src-tauri/target/share-extension`)
  })

  it('is copied from where the build leaves it into Contents/PlugIns', () => {
    expect(config.bundle.macOS.files).toEqual({
      'PlugIns/DevotShare.appex': 'target/share-extension/DevotShare.appex',
    })
  })
})

describe.skipIf(process.platform !== 'darwin')('the share extension on a Mac', () => {
  let appex = ''

  beforeAll(() => {
    appex = join(tempDir('devot-share-ext-'), 'DevotShare.appex')
    tool(SCRIPT, [join(appex, '..')])
  }, TIMEOUT)

  it(
    'builds the links the app reads',
    () => {
      const check = join(tempDir('devot-share-check-'), 'check')
      tool('xcrun', [
        'swiftc',
        '-swift-version',
        '6',
        '-warnings-as-errors',
        '-o',
        check,
        join(SOURCE, 'CaptureLink.swift'),
        join(SOURCE, 'Checks', 'main.swift'),
      ])
      expect(tool(check, ['tests/fixtures/capture-links.json'])).toMatch(
        /^CaptureLink: all \d+ cases pass/,
      )
    },
    TIMEOUT,
  )

  it('is a universal Share menu extension of the app version, for the app minimum macOS', () => {
    const info = JSON.parse(
      tool('plutil', ['-convert', 'json', '-o', '-', join(appex, 'Contents', 'Info.plist')]),
    ) as Record<string, unknown>
    const version = json('package.json')['version']
    const minimum = (
      json('src-tauri/tauri.conf.json') as { bundle: { macOS: { minimumSystemVersion: string } } }
    ).bundle.macOS.minimumSystemVersion
    const executable = join(appex, 'Contents', 'MacOS', 'DevotShare')
    expect({
      executable: info['CFBundleExecutable'],
      id: info['CFBundleIdentifier'],
      type: info['CFBundlePackageType'],
      platforms: info['CFBundleSupportedPlatforms'],
      versions: [info['CFBundleShortVersionString'], info['CFBundleVersion']],
      minimum: info['LSMinimumSystemVersion'],
      point: (info['NSExtension'] as Record<string, unknown>)['NSExtensionPointIdentifier'],
      archs: tool('lipo', ['-archs', executable]).trim().split(' ').sort(),
    }).toEqual({
      executable: 'DevotShare',
      id: `${json('src-tauri/tauri.conf.json')['identifier'] as string}.share`,
      type: 'XPC!',
      platforms: ['MacOSX'],
      versions: [version, version],
      minimum,
      point: 'com.apple.share-services',
      archs: ['arm64', 'x86_64'],
    })
    const principal = (info['NSExtension'] as Record<string, unknown>)['NSExtensionPrincipalClass']
    expect(readFileSync(join(SOURCE, 'ShareViewController.swift'), 'utf8')).toContain(
      `@objc(${principal as string})`,
    )
  })

  it('is signed with the sandbox alone, which macOS loads no extension without', () => {
    tool('codesign', ['--verify', '--strict', appex])
    const xml = tool('codesign', ['-d', '--entitlements', '-', '--xml', appex])
    const carried = JSON.parse(tool('plutil', ['-convert', 'json', '-o', '-', '-'], xml)) as unknown
    expect(carried).toEqual({ 'com.apple.security.app-sandbox': true })
  })
})
