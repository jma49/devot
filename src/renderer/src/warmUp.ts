import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Core } from './core-client'
import { patchPieces } from './preview/dom'
import { previewLabels } from './preview/Preview'

/** The code fence languages notes use most; others still load on first use. */
export const WARM_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'json',
  'shell',
  'css',
  'html',
  'rust',
  'go',
  'sql',
  'java',
  'yaml',
] as const

const WARM_BLOCKS = [
  '## Blocks',
  'Some **bold**, *emphasis*, ~~strike~~, `code` and a [link](https://example.com).',
  '- One\n  - Nested\n- [x] Done\n- [ ] Open',
  '1. Step',
  '> [!NOTE]\n> An alert.',
  '| A | B |\n| --- | ---: |\n| 1 | 2 |',
  '$$\nx^2\n$$',
  '---',
].join('\n\n')

/** Just long enough for two pieces, so the first piece's path and the others' both run. */
export const WARM_SAMPLE = [
  '# Warm',
  ':sparkles: $e^{i\\pi} + 1 = 0$',
  ...WARM_LANGUAGES.map((lang) => `\`\`\`${lang}\nx\n\`\`\``),
  ...Array.from({ length: 12 }, () => WARM_BLOCKS),
].join('\n\n')

type Idle = (run: () => void, options: { timeout: number }) => unknown

/**
 * Runs what the first note open would otherwise run cold (the piecewise preview render and patch,
 * highlighting, math, emoji, the editor's code languages) once the window is idle, so the first
 * open costs what later ones do.
 */
export function warmUp(core: Core, schedule: Idle = idle): void {
  schedule(
    () => {
      void core
        .renderPreviewPieces(WARM_SAMPLE, { labels: previewLabels(), loadedEmbeds: [] }, [])
        .then((pieces) => patchPieces(document.createElement('div'), [], pieces))
        .catch(() => {})
      for (const name of WARM_LANGUAGES) {
        void LanguageDescription.matchLanguageName(languages, name)
          ?.load()
          .catch(() => {})
      }
    },
    { timeout: 3000 },
  )
}

function idle(run: () => void, options: { timeout: number }): unknown {
  const host = globalThis as { requestIdleCallback?: Idle }
  return host.requestIdleCallback
    ? host.requestIdleCallback(run, options)
    : setTimeout(run, options.timeout / 2)
}
