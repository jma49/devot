import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TokenTree } from '../../scripts/tokens/compile'
import { compileLaunchColor, LAUNCH_COLOR } from '../../scripts/tokens/launch'

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as TokenTree
const launch = compileLaunchColor(
  read('design/tokens/base.tokens.json'),
  read('design/tokens/themes/system.light.tokens.json'),
  read('design/tokens/themes/system.dark.tokens.json'),
)
const storyboard = readFileSync('src-tauri/gen/apple/LaunchScreen.storyboard', 'utf8')

describe('the launch screen', () => {
  it('takes its background from the committed colour, the phone background of each appearance', () => {
    expect(readFileSync(LAUNCH_COLOR, 'utf8')).toBe(launch)
    const { colors } = JSON.parse(launch) as {
      colors: { appearances?: { value: string }[]; color: { components: Record<string, string> } }[]
    }
    expect(colors.map((c) => c.appearances?.[0]?.value ?? 'any')).toStrictEqual(['any', 'dark'])
  })

  it('draws only that colour: no colour literal of its own but the fallback IB keeps for it', () => {
    const named = [...storyboard.matchAll(/<color key="(\w+)" (\w+)="([^"]+)"/g)].map((m) => [
      m[2],
      m[3],
    ])
    expect(named.length).toBeGreaterThan(0)
    expect(named.every(([kind, name]) => kind === 'name' && name === 'LaunchBackground')).toBe(true)
    const { colors } = JSON.parse(launch) as {
      colors: { color: { components: Record<string, string> } }[]
    }
    const light = colors[0]!.color.components
    const fallback =
      /<namedColor name="LaunchBackground">\s*<color red="([\d.]+)" green="([\d.]+)" blue="([\d.]+)"/.exec(
        storyboard,
      )
    expect(fallback?.slice(1).map(Number)).toStrictEqual(
      [light['red'], light['green'], light['blue']].map(Number),
    )
  })
})
