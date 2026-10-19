import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import type { Core } from './core-client'
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

export const WARM_SAMPLE = [
  '# Warm',
  ':sparkles: $e^{i\\pi} + 1 = 0$',
  ...WARM_LANGUAGES.map((lang) => `\`\`\`${lang}\nx\n\`\`\``),
].join('\n\n')

type Idle = (run: () => void, options: { timeout: number }) => unknown

/**
 * Loads what the first note open would otherwise wait for (preview highlighting, math, emoji, the
 * editor's code languages) once the window is idle, so the first open costs what later ones do.
 */
export function warmUp(core: Core, schedule: Idle = idle): void {
  schedule(
    () => {
      void core
        .renderPreview(WARM_SAMPLE, { labels: previewLabels(), loadedEmbeds: [] })
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
