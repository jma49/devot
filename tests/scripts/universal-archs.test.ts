import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const SCRIPT = 'scripts/release/universal-archs.sh'

function check(archs: string) {
  return spawnSync('sh', [SCRIPT, archs], { encoding: 'utf8' }).status
}

describe('the universal check on lipo -archs', () => {
  it.each(['x86_64 arm64', 'arm64 x86_64', 'x86_64 arm64\n'])('passes both slices: %j', (archs) => {
    expect(check(archs)).toBe(0)
  })

  it.each(['arm64', 'x86_64', '', 'arm64 arm64', 'arm64e x86_64', 'arm64 x86_64 i386'])(
    'refuses anything else: %j',
    (archs) => {
      expect(check(archs)).toBe(1)
    },
  )
})
