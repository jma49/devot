// Syntax highlighting for code blocks in the preview, on lowlight. Every
// highlight.js grammar is available, and each loads on first use (grammars.ts
// maps names and aliases to loaders), so a note pays only for the languages
// its code blocks use. This module loads only when a note has a code block
// with a language (see code.ts). Its output is hast of `span.hljs-*` and text
// nodes, built from the code as text: note content never becomes markup.
import type { ElementContent } from 'hast'
import { createLowlight } from 'lowlight'
import { joinOperatorRunsInHast } from '../operatorRuns'
import { GRAMMARS, GRAMMAR_ALIASES } from './grammars'

const lowlight = createLowlight()
const loading = new Map<string, Promise<void>>()

/** The grammar `language` names (a grammar or an alias of one), or null. */
function grammarName(language: string): string | null {
  const key = language.toLowerCase()
  if (Object.hasOwn(GRAMMARS, key)) return key
  const alias = Object.hasOwn(GRAMMAR_ALIASES, key) ? GRAMMAR_ALIASES[key] : undefined
  return alias ?? null
}

function ensure(name: string): Promise<void> {
  let pending = loading.get(name)
  if (!pending) {
    const load = GRAMMARS[name]!
    pending = load().then(
      (module) => {
        lowlight.register({ [name]: module.default })
      },
      () => {
        // Retry on the next rendering; the block shows as plain text now.
        loading.delete(name)
        console.warn('W_GRAMMAR_LOAD_FAILED')
      },
    )
    loading.set(name, pending)
  }
  return pending
}

/**
 * `code` highlighted as `language`, or null when there is no such grammar.
 * Each operator (`!=`, `=>`) stays in one element, so a code font can draw
 * it as a ligature.
 */
export async function highlight(language: string, code: string): Promise<ElementContent[] | null> {
  const name = grammarName(language)
  if (!name) return null
  await ensure(name)
  if (!lowlight.registered(name)) return null
  return joinOperatorRunsInHast(lowlight.highlight(name, code).children as ElementContent[])
}
