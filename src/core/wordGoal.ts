// A note's word goal is its own front matter key, so it syncs, exports and imports with the text and
// needs no field of its own. It is read with a line scan, not the YAML parser, because the editor
// footer reads it on the page after every pause in typing.
import { frontMatterHead } from './frontMatterHead'

export const WORD_GOAL_KEY = 'word-goal'
export const MAX_WORD_GOAL = 10_000_000

const LINE = /^word-goal:[ \t]*(?:'([^']*)'|"([^"]*)"|([^#'"\r\n]*?))[ \t]*(?:#.*)?$/m

export function wordGoal(markdown: string): number | null {
  const head = frontMatterHead(markdown)
  if (head === null) return null
  const found = LINE.exec(head)
  if (!found) return null
  const digits = (found[1] ?? found[2] ?? found[3] ?? '').trim().replace(/[,_]/g, '')
  if (!/^\d+$/.test(digits)) return null
  const goal = Number(digits)
  return goal > 0 && goal <= MAX_WORD_GOAL ? goal : null
}
