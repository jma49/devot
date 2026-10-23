import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flatten, resolve, type TokenTree } from '../../scripts/tokens/compile'
import { contrastRatio, parseColor, type Rgb } from '../../src/renderer/src/theme/contrast'

// The app icon and logo colours (color.brand.*, design/app-icon/): the dove is a graphic, so it
// needs 3:1 against its tile, and the wordmark is text, so it needs 4.5:1 on the ground it is drawn for.

const base = flatten(
  JSON.parse(readFileSync('design/tokens/base.tokens.json', 'utf8')) as TokenTree,
)
const brand = resolve(
  base.filter((t) => t.path.startsWith('color.brand.')),
  base,
)
const names = brand.map((t) => t.path.slice('color.brand.'.length))

const rgb = (name: string): Rgb => {
  const token = brand.find((t) => t.path === `color.brand.${name}`)
  if (!token) throw new Error(`no token color.brand.${name}`)
  return parseColor((token.value as { hex: string }).hex).rgb
}

const APPEARANCES = [
  { appearance: 'light', suffix: '' },
  { appearance: 'dark', suffix: '-dark' },
]

describe('brand colours', () => {
  it('are colours, each resolved to a value', () => {
    expect(brand.length).toBeGreaterThan(0)
    expect(
      brand.filter(
        (t) => t.type !== 'color' || typeof (t.value as { hex?: unknown }).hex !== 'string',
      ),
    ).toEqual([])
  })

  it('give the tile, the dove and the wordmark a colour for each appearance', () => {
    const parts = ['tile-top', 'tile-bottom', 'dove-top', 'dove-middle', 'dove-bottom', 'wordmark']
    const wanted = parts.flatMap((part) => [part, `${part}-dark`])
    expect(wanted.filter((name) => !names.includes(name))).toEqual([])
  })

  it.each(APPEARANCES)(
    'stand the dove 3:1 from its tile at every stop ($appearance)',
    ({ suffix }) => {
      for (const dove of ['dove-top', 'dove-middle', 'dove-bottom']) {
        for (const tile of ['tile-top', 'tile-bottom']) {
          const ratio = contrastRatio(rgb(dove + suffix), rgb(tile + suffix))
          expect(ratio, `${dove}${suffix} on ${tile}${suffix}`).toBeGreaterThanOrEqual(3)
        }
      }
    },
  )

  it.each(APPEARANCES)(
    'set the wordmark at 4.5:1 on the tile colours ($appearance)',
    ({ suffix }) => {
      for (const ground of ['tile-top', 'tile-bottom']) {
        const ratio = contrastRatio(rgb(`wordmark${suffix}`), rgb(ground + suffix))
        expect(ratio, `wordmark${suffix} on ${ground}${suffix}`).toBeGreaterThanOrEqual(4.5)
      }
    },
  )
})
