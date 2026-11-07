import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const MINIMUM = 26

const read = (path: string) => readFileSync(path, 'utf8')
const major = (value: string) => Number(value.split('.')[0])

const projectYml = () =>
  /deploymentTarget:\s*\n\s*iOS:\s*'?([\d.]+)'?/.exec(read('src-tauri/gen/apple/project.yml'))?.[1]
const pbxproj = () =>
  [
    ...read('src-tauri/gen/apple/devot.xcodeproj/project.pbxproj').matchAll(
      /IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g,
    ),
  ].map((m) => m[1] ?? '')
const podfile = () => /platform :ios, '([\d.]+)'/.exec(read('src-tauri/gen/apple/Podfile'))?.[1]

describe('iPhone deployment target', () => {
  it('is iOS 26 or later in the XcodeGen project', () => {
    expect(major(projectYml() ?? '0')).toBeGreaterThanOrEqual(MINIMUM)
  })

  it('is iOS 26 or later in every build configuration of the Xcode project', () => {
    const targets = pbxproj()
    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) expect(major(target)).toBeGreaterThanOrEqual(MINIMUM)
  })

  it('agrees across the XcodeGen project, the Xcode project and the Podfile', () => {
    expect(new Set([projectYml(), ...pbxproj(), podfile()]).size).toBe(1)
  })
})
