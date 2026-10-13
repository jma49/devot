// Writes the generated token files. `--check` fails instead of writing when
// the committed output is stale (CI runs it).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile, type TokenTree } from './compile.ts'

const root = join(import.meta.dirname, '../..')
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as TokenTree

const { css, ts } = compile(
  read('design/tokens/base.tokens.json'),
  read('design/tokens/themes/system.light.tokens.json'),
  read('design/tokens/themes/system.dark.tokens.json'),
)

const outputs: [string, string][] = [
  ['src/renderer/src/theme/tokens.css', css],
  ['src/renderer/src/theme/tokens.ts', ts],
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
  for (const [path, content] of outputs) writeFileSync(join(root, path), content)
}
