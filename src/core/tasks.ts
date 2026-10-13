// Task progress: how many of a note's task items (`- [ ]`, `- [x]`) are
// ticked. The preview's info card and note-link chips show it.

export interface TaskProgress {
  done: number
  total: number
}

const TASK = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/
const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/

/**
 * Counts the task items in Markdown, ticked or not. Lines inside fenced
 * code blocks are not tasks.
 */
export function taskProgress(markdown: string): TaskProgress {
  let done = 0
  let total = 0
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const opens = FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (opens && opens[0] === fence[0] && opens.length >= fence.length) fence = null
      continue
    }
    if (opens) {
      fence = opens
      continue
    }
    const mark = TASK.exec(line)?.[1]
    if (mark === undefined) continue
    total += 1
    if (mark !== ' ') done += 1
  }
  return { done, total }
}
