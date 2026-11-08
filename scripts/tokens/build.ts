// Writes the generated token files. `--check` fails instead of writing when
// the committed output is stale (CI runs it).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { compile, type TokenTree } from './compile.ts'
import { compileLaunchColor, LAUNCH_COLOR } from './launch.ts'
import { compileSwift, SWIFT_TOKENS } from './swift.ts'
import { BUILT_IN_THEMES } from './themes.ts'

const root = join(import.meta.dirname, '../..')
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as TokenTree

const sources = [
  read('design/tokens/base.tokens.json'),
  read('design/tokens/themes/system.light.tokens.json'),
  read('design/tokens/themes/system.dark.tokens.json'),
  BUILT_IN_THEMES.map(({ id }) => ({
    id,
    light: read(`design/tokens/themes/${id}.light.tokens.json`),
    dark: read(`design/tokens/themes/${id}.dark.tokens.json`),
  })),
  read('design/tokens/backdrops.tokens.json'),
] as const
const { css, ts } = compile(...sources)

const outputs: [string, string][] = [
  ['src/renderer/src/theme/tokens.css', css],
  ['src/renderer/src/theme/tokens.ts', ts],
  [SWIFT_TOKENS, compileSwift(...sources)],
  [LAUNCH_COLOR, compileLaunchColor(sources[0], sources[1], sources[2])],
]

if (process.argv.includes('--check')) {
  const stale = outputs.filter(([path, content]) => {
    try {
      return readFileSync(join(root, path), 'utf8') !== content
    } catch {
      return true
    }
  })
  if (stale.length > 0) {
    console.error(`E_TOKENS_STALE ${stale.map(([p]) => p).join(' ')}: run pnpm tokens`)
    process.exit(1)
  }
} else {
  for (const [path, content] of outputs) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}
