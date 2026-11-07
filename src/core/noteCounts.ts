import { readableText } from './readable'
import { countWords, isSpaceCode, unitsAt } from './words'

export interface NoteCounts {
  readonly words: number
  /** Characters other than whitespace. */
  readonly characters: number
}

/** Code points other than whitespace. */
function nonSpace(text: string): number {
  let characters = 0
  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at)
    if (!isSpaceCode(code)) characters++
    at += code < 0x80 ? 1 : unitsAt(text, at)
  }
  return characters
}

/**
 * What a note shows as its length, on the Mac and the phone alike: the text a reader sees, so front
 * matter, the Markdown of links and images (their label or alt text stays) and bare marks are left out.
 */
export function noteCounts(markdown: string): NoteCounts {
  const text = readableText(markdown)
  return { words: countWords(text), characters: nonSpace(text) }
}
