import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// The web view reports only the languages the bundle declares, so a missing entry hides its catalog.
const LOCALIZATIONS = ['en', 'zh-Hans']

function plistStrings(plist: string, key: string): string[] | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist)
  return match ? [...match[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!) : undefined
}

describe('the app bundles declare every shipped language', () => {
  it('declares them in the iPhone Info.plist', () => {
    const plist = readFileSync('src-tauri/gen/apple/devot_iOS/Info.plist', 'utf8')
    expect(plistStrings(plist, 'CFBundleLocalizations')).toEqual(LOCALIZATIONS)
  })

  it('declares them in project.yml, so a regenerated Info.plist keeps them', () => {
    const project = parse(readFileSync('src-tauri/gen/apple/project.yml', 'utf8')) as {
      targets: Record<string, { info?: { properties?: Record<string, unknown> } }>
    }
    expect(project.targets['devot_iOS']?.info?.properties?.['CFBundleLocalizations']).toEqual(
      LOCALIZATIONS,
    )
  })

  it('declares them in the Mac Info.plist that Tauri merges', () => {
    const plist = readFileSync('src-tauri/Info.plist', 'utf8')
    expect(plistStrings(plist, 'CFBundleLocalizations')).toEqual(LOCALIZATIONS)
  })
})
