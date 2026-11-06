// What the open note's Note Info summary and card count, read from its Markdown.
import { taskProgress, type TaskProgress } from './extract'
import { frontMatter } from './import'
import { noteCounts } from './noteCounts'
import { frontMatterView, type FrontMatterView } from './preview/frontMatterView'
import type { PreviewNote } from './preview/registry'

export interface NoteFacts {
  tasks: TaskProgress
  words: number
  frontMatter: FrontMatterView | null
}

const CLOSE = /(?:\r\n?|\n)---[ \t]*(?=\r\n?|\n|(?![\s\S]))/g

/** The front matter fence and what it holds, so a long note is not parsed whole to find it. */
function head(markdown: string): string | null {
  if (!/^---[ \t]*(?:\r\n?|\n)/.test(markdown)) return null
  CLOSE.lastIndex = 3
  return CLOSE.exec(markdown) ? markdown.slice(0, CLOSE.lastIndex) : null
}

export function noteFacts(
  markdown: string,
  note: PreviewNote | undefined,
  untitled: string,
): NoteFacts {
  const fenced = head(markdown)
  const yaml = fenced === null ? null : frontMatter(fenced)
  return {
    tasks: taskProgress(markdown),
    words: noteCounts(markdown).words,
    frontMatter: yaml === null ? null : frontMatterView(yaml, note, untitled),
  }
}
