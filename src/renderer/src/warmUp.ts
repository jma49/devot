import { LanguageDescription } from '@codemirror/language'
import { useEffect, useInsertionEffect, useRef } from 'react'
import { languages as editorLanguages } from '@codemirror/language-data'
import type { WarmFeatures } from '../../core/preview/warmFeatures'
import type { Core } from './core-client'
import { patchPieces } from './preview/dom'
import { previewLabels } from './preview/Preview'

const blocks = (math: boolean) =>
  [
    '## Blocks',
    'Some **bold**, *emphasis*, ~~strike~~, `code` and a [link](https://example.com).',
    '- One\n  - Nested\n- [x] Done\n- [ ] Open',
    '1. Step',
    '> [!NOTE]\n> An alert.',
    '| A | B |\n| --- | ---: |\n| 1 | 2 |',
    ...(math ? ['$$\nx^2\n$$'] : []),
    '---',
  ].join('\n\n')

/**
 * The blocks any note may show, just long enough for two pieces, with only the code languages,
 * math and emoji the notes use: warming a fixed list whatever the notes held kept their grammars
 * in memory (issue 742).
 */
export function warmSample({ languages, math, emoji }: WarmFeatures): string {
  const opening = [...(emoji ? [':sparkles:'] : []), ...(math ? ['$e^{i\\pi} + 1 = 0$'] : [])]
  return [
    '# Warm',
    ...(opening.length > 0 ? [opening.join(' ')] : []),
    ...languages.map((lang) => `\`\`\`${lang}\nx\n\`\`\``),
    ...Array.from({ length: 12 }, () => blocks(math)),
  ].join('\n\n')
}

type Idle = (run: () => void, options: { timeout: number }) => unknown

/** The open note's text and the IDs the note list shows, in order. */
export type WarmSource = () => { text: string; listed: readonly string[] }

/**
 * Runs what the first preview would otherwise run cold (the piecewise preview render and patch,
 * and the highlighting, math, emoji and editor languages the open note and the first listed notes
 * use) once the window is idle. `source` is read only then.
 */
export function warmUp(core: Core, source: WarmSource, schedule: Idle = idle): void {
  schedule(
    () => {
      const { text, listed } = source()
      void core
        .warmFeatures(text, [...listed])
        .then((features) => {
          for (const name of features.languages) {
            void LanguageDescription.matchLanguageName(editorLanguages, name)
              ?.load()
              .catch(() => {})
          }
          return core.warmPreviewPieces(warmSample(features), {
            labels: previewLabels(),
            loadedEmbeds: [],
          })
        })
        .then((pieces) => patchPieces(document.createElement('div'), [], pieces))
        .catch(() => {})
    },
    { timeout: 3000 },
  )
}

/**
 * Warms up once, when `ready` first holds. The open note's text and `listed` are read when the
 * window is idle, so a list still filling when the window got ready is warmed as it stands then.
 */
export function useWarmUp(
  core: Core | undefined,
  ready: boolean,
  text: () => string,
  listed: readonly string[],
  schedule: Idle = idle,
): void {
  const latest = useRef({ text, listed })
  useInsertionEffect(() => {
    latest.current = { text, listed }
  })
  const warmed = useRef(false)
  useEffect(() => {
    if (!core || !ready || warmed.current) return
    warmed.current = true
    warmUp(core, () => ({ text: latest.current.text(), listed: latest.current.listed }), schedule)
  }, [core, ready, schedule])
}

function idle(run: () => void, options: { timeout: number }): unknown {
  const host = globalThis as { requestIdleCallback?: Idle }
  return host.requestIdleCallback
    ? host.requestIdleCallback(run, options)
    : setTimeout(run, options.timeout / 2)
}
