// Fails when Swift code outside a Generated/ folder spells a colour instead of taking it from
// Tokens.swift (`pnpm lint` runs it).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LITERAL = /\bUIColor\((red|white):|\bColor\((red|white|hex)\b|#colorLiteral\(/

/** `path:line` of each colour literal in `text`; a generated file has none by definition. */
export function colourLiterals(path: string, text: string): string[] {
  if (path.split('/').includes('Generated')) return []
  return text.split('\n').flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    return LITERAL.test(code) ? [`${path}:${i + 1}`] : []
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(import.meta.dirname, '../..')
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', '*.swift'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  const found = files.flatMap((file) =>
    colourLiterals(file, readFileSync(join(root, file), 'utf8')),
  )
  if (found.length > 0) {
    console.error(`E_SWIFT_COLOUR_LITERAL ${found.join(' ')}: use Tokens.Color`)
    process.exit(1)
  }
}
