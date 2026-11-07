import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

// Without the key a ProMotion iPhone caps Core Animation and the display link at 60 Hz
// (docs/specs/performance.md).
const APPLE = 'src-tauri/gen/apple'
const KEY = 'CADisableMinimumFrameDurationOnPhone'

function plistBoolean(plist: string, key: string): boolean | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(plist)
  return match ? match[1] === 'true' : undefined
}

describe('the iPhone draws at the display refresh rate', () => {
  it('sets the key in Info.plist', () => {
    const plist = readFileSync(`${APPLE}/devot_iOS/Info.plist`, 'utf8')
    expect(plistBoolean(plist, KEY)).toBe(true)
  })

  it('sets the key in project.yml, so a regenerated Info.plist keeps it', () => {
    const project = parse(readFileSync(`${APPLE}/project.yml`, 'utf8')) as {
      targets: Record<string, { info?: { properties?: Record<string, unknown> } }>
    }
    expect(project.targets['devot_iOS']?.info?.properties?.[KEY]).toBe(true)
  })
})
