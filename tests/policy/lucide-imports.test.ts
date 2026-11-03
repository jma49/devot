import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

// Importing all of Lucide, or the notebook glyphs statically, would put them in the startup bundle.
const root = 'src/renderer/src'
const sources = (readdirSync(root, { recursive: true }) as string[])
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => [file, readFileSync(join(root, file), 'utf8')] as const)

it('the UI takes Lucide icons by name, never the whole package', () => {
  expect(
    sources
      .filter(([, text]) => /import \* as \w+ from 'lucide-react|lucide-react\/dynamic/.test(text))
      .map(([file]) => file),
  ).toEqual([])
})

it('the notebook glyphs load through one dynamic import', () => {
  expect(
    sources
      .filter(([, text]) => /(?:from|import) '[^']*lucideNotebook'/.test(text))
      .map(([file]) => file),
  ).toEqual([])
  expect(sources.filter(([, text]) => text.includes("import('./lucideNotebook')")).length).toBe(1)
})
