// What the open note's Note Info summary and card count, read from its Markdown.
import { taskProgress, type TaskProgress } from './extract'
import { frontMatter } from './import'
import { noteCounts, type NoteCounts } from './noteCounts'
import { frontMatterView, type FrontMatterView } from './preview/frontMatterView'
import type { PreviewNote } from './preview/registry'

export interface NoteFacts {
  tasks: TaskProgress
  words: number
  frontMatter: FrontMatterView | null
}

/** What the whole note is counted for, once per pause: the footer's counts and Note Info's. */
export interface NoteTally extends NoteCounts {
  readonly tasks: TaskProgress
}

const CLOSE = /(?:\r\n?|\n)---[ \t]*(?=\r\n?|\n|(?![\s\S]))/g

/** The front matter fence and what it holds, so a long note is not parsed whole to find it. */
export function frontMatterHead(markdown: string): string | null {
  if (!/^---[ \t]*(?:\r\n?|\n)/.test(markdown)) return null
  CLOSE.lastIndex = 3
  return CLOSE.exec(markdown) ? markdown.slice(0, CLOSE.lastIndex) : null
}

export function noteTally(markdown: string): NoteTally {
  return { ...noteCounts(markdown), tasks: taskProgress(markdown) }
}

/** `markdown` may be the whole note or only its `frontMatterHead`. */
export function noteFrontMatter(
  markdown: string,
  note: PreviewNote | undefined,
  untitled: string,
): FrontMatterView | null {
  const fenced = frontMatterHead(markdown)
  const yaml = fenced === null ? null : frontMatter(fenced)
  return yaml === null ? null : frontMatterView(yaml, note, untitled)
}
