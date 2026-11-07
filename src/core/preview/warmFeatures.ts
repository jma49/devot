import type { StorageAdapter } from '../storage'

export const MAX_WARM_LANGUAGES = 12
/** About a screen of the note list: the notes most likely opened next. */
export const WARM_NOTES = 20

/** What a window warms before the first preview: code languages, math and emoji. */
export interface WarmFeatures {
  languages: string[]
  math: boolean
  emoji: boolean
}

const FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm
const EMOJI = /:[\w+-]+:/

/** The first word of each fence's info string in order of first use, and whether math or emoji appear. */
export function warmFeatures(markdowns: readonly string[]): WarmFeatures {
  const languages = new Set<string>()
  let math = false
  let emoji = false
  for (const markdown of markdowns) {
    for (const [, name] of markdown.matchAll(FENCE)) {
      if (languages.size === MAX_WARM_LANGUAGES) break
      languages.add(name!.toLowerCase())
    }
    math ||= markdown.indexOf('$') !== markdown.lastIndexOf('$')
    emoji ||= EMOJI.test(markdown)
  }
  return { languages: [...languages], math, emoji }
}

/**
 * What the open note and the first `WARM_NOTES` of `listed` use, so warm-up loads only those
 * grammars and renderers yet the next note opened from the list still opens warm (issue 742).
 */
export async function libraryWarmFeatures(
  storage: Pick<StorageAdapter, 'getBodies'>,
  openText: string,
  listed: readonly string[],
): Promise<WarmFeatures> {
  const bodies = listed.length === 0 ? [] : await storage.getBodies(listed.slice(0, WARM_NOTES))
  return warmFeatures([openText, ...bodies.map((body) => body.bodyMd)])
}
