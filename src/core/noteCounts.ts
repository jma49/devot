import { readableText } from './readable'
import { countWords } from './words'

export interface NoteCounts {
  readonly words: number
  /** Characters other than whitespace. */
  readonly characters: number
}

/**
 * What a note shows as its length, on the Mac and the phone alike: the text a reader sees, so front
 * matter, the Markdown of links and images (their label or alt text stays) and bare marks are left out.
 */
export function noteCounts(markdown: string): NoteCounts {
  const text = readableText(markdown)
  let characters = 0
  for (const c of text) if (!/\s/u.test(c)) characters++
  return { words: countWords(text), characters }
}
