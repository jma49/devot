// The launch screen's background as an asset catalog colour, from the default theme's
// `color.phone.background`, so the frame before the app draws matches its first one; `build.ts` writes it.
import { flatten, resolve, type ColorValue, type TokenTree } from './compile.ts'

export const LAUNCH_COLOR =
  'src-tauri/gen/apple/Assets.xcassets/LaunchBackground.colorset/Contents.json'
export const LAUNCH_TOKEN = 'color.phone.background'

const component = (x: number) => (Math.round(x * 1000) / 1000).toFixed(3)

function entry(tree: TokenTree, base: TokenTree, appearance?: 'dark') {
  const token = resolve(flatten(tree), flatten(base)).find((t) => t.path === LAUNCH_TOKEN)
  if (token?.type !== 'color') throw new Error(`E_TOKEN_LAUNCH ${appearance ?? 'light'}`)
  const value = token.value as ColorValue
  const [red, green, blue] = value.components.map(component)
  return {
    ...(appearance ? { appearances: [{ appearance: 'luminosity', value: appearance }] } : {}),
    color: {
      'color-space': 'srgb',
      components: { alpha: component(value.alpha ?? 1), blue, green, red },
    },
    idiom: 'universal',
  }
}

export function compileLaunchColor(base: TokenTree, light: TokenTree, dark: TokenTree): string {
  const contents = {
    colors: [entry(light, base), entry(dark, base, 'dark')],
    info: { author: 'xcode', version: 1 },
  }
  return `${JSON.stringify(contents, null, 2)}\n`
}
