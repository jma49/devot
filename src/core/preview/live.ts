// The open note's live preview as the core worker renders it: the pieces, and what the page
// shows beside them (task progress, line count, linked notes), all read from the text off the
// page's thread, which then only posts the text and patches the result in.
import { frontMatterEnd, tasksIn } from '../extract'
import { sameFence, type Fence } from '../fences'
import { noteLinks } from '../links'
import type { TaskProgress } from '../tasks'
import { createBlockSplitter, type NoteSplit } from './blocks'
import { PIECE_LENGTH, type PreviewPiece } from './index'
import type { NoteLinkTarget, PreviewOptions } from './registry'

export interface LivePreview {
  pieces: PreviewPiece[]
  tasks: TaskProgress
  lines: number
  /** The notes the text links to, sorted. */
  links: string[]
}

type Targets = Readonly<Record<string, NoteLinkTarget>>

export interface LivePreviewSources {
  renderPieces: (
    markdown: string,
    options: PreviewOptions,
    known: readonly string[],
  ) => Promise<PreviewPiece[]>
  linkTargets: (ids: readonly string[]) => Promise<Targets>
  onTargetsFailed: () => void
  /** A reader of the splitter `renderPieces` cuts with (`shareSplitter`), so a text is cut once. */
  split?: (markdown: string) => NoteSplit
}

/** Link targets asked for at once by different previews (scopes) kept before the oldest is dropped. */
const KEPT_TARGETS = 8

function newlines(text: string): number {
  let count = 0
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1
  return count
}

type BlockTasks = TaskProgress & { fence: Fence | undefined; after: Fence | undefined }

/**
 * A note's task progress and line count, read again after an edit only from the pieces it
 * changed: each piece's tasks are kept with the code fence open where it starts.
 */
export function createSplitFacts(
  split: (markdown: string) => NoteSplit,
): (markdown: string) => { tasks: TaskProgress; lines: number } {
  let before: (BlockTasks | undefined)[] = []
  return (markdown) => {
    const { blocks, was } = split(markdown)
    const start = frontMatterEnd(markdown)
    const counted: (BlockTasks | undefined)[] = []
    let fence: Fence | undefined
    let done = 0
    let total = 0
    for (const [i, { text, offset }] of blocks.entries()) {
      const end = offset + text.length
      if (end <= start) {
        counted.push(undefined)
        continue
      }
      const kept = start <= offset ? before[was[i]!] : undefined
      let found = kept && sameFence(kept.fence, fence) ? kept : undefined
      if (!found) {
        const read = tasksIn(start > offset ? text.slice(start - offset) : text, fence)
        found = { done: read.done, total: read.total, fence, after: read.fence }
      }
      counted.push(start <= offset ? found : undefined)
      done += found.done
      total += found.total
      fence = found.after
    }
    before = counted
    const last = blocks.at(-1)!
    return { tasks: { done, total }, lines: last.line + newlines(last.text) }
  }
}

/**
 * `scope` names whose link targets may be reused: the targets are asked for again when the scope
 * or the set of linked notes changes (the page changes its scope when another note opens or a
 * linked note changes). Targets that fail are not kept, and the pieces render without them.
 */
export function createLivePreviewRenderer(
  sources: LivePreviewSources,
): (
  markdown: string,
  options: Omit<PreviewOptions, 'noteLinks'>,
  known: readonly string[],
  scope: string,
) => Promise<LivePreview> {
  const kept = new Map<string, Promise<Targets | undefined>>()
  const facts = createSplitFacts(sources.split ?? createBlockSplitter(PIECE_LENGTH))

  const targetsFor = (ids: string[], scope: string): Promise<Targets | undefined> => {
    if (ids.length === 0) return Promise.resolve({})
    const key = `${scope}\u0000${ids.join(' ')}`
    const known = kept.get(key)
    if (known) {
      kept.delete(key)
      kept.set(key, known)
      return known
    }
    const asked = sources.linkTargets(ids).catch(() => {
      sources.onTargetsFailed()
      kept.delete(key)
      return undefined
    })
    kept.set(key, asked)
    for (const oldest of kept.keys()) {
      if (kept.size <= KEPT_TARGETS) break
      kept.delete(oldest)
    }
    return asked
  }

  return async (markdown, options, known, scope) => {
    const links = noteLinks(markdown)
    const targets = await targetsFor(links, scope)
    const pieces = await sources.renderPieces(
      markdown,
      targets ? { ...options, noteLinks: targets } : options,
      known,
    )
    return { pieces, ...facts(markdown), links }
  }
}
