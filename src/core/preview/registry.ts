// The internal extension point for preview renderers: a renderer transforms the sanitized HTML tree (hast) of a note. Renderers run after sanitizing, so whatever they
// add is trusted: they must only build structure from validated values, never pass note text through as markup.
import type { Root } from 'hast'
import type { NoteStatus, TagColor } from '../storage'
import type { TaskProgress } from '../tasks'

export const PREVIEW_API_VERSION = 1

/** Properties carrying an offset into the note's Markdown. */
export const PIECE_OFFSET_PROPERTIES = ['dataTaskAt', 'dataImageFrom', 'dataImageTo'] as const

export interface PreviewLabels {
  alerts: Record<AlertKind, string>
  embedFrom: string
  embedLoad: string
  videoTitle: string
  untitled: string
  missingNote: string
  codeLines: string
  codeLine: string
  codeRef: string
  codeSource: string
}

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

export interface NoteLinkTarget {
  title: string
  status: NoteStatus
  tasks: TaskProgress
  tags: { name: string; color: TagColor | null }[]
}

/** The open note's own fields, so its front matter can show what differs from them. */
export interface PreviewNote {
  title: string
  status: NoteStatus
  /** The names of the note's tags. */
  tags: readonly string[]
  /** The library's tags that have a colour, so a front-matter tag naming one is drawn in it. */
  tagColors: readonly { name: string; color: TagColor }[]
  /** False while the note cannot be changed: what differs shows without Apply. */
  canApply: boolean
  labels: {
    statuses: Record<NoteStatus, string>
    /** `{value}` is the note's own value. */
    noteValue: string
    noTags: string
    apply: string
    applyTitle: string
    applyStatus: string
    applyTags: string
  }
}

export interface PreviewOptions {
  labels: PreviewLabels
  loadedEmbeds: readonly string[]
  /** Without it (exported pages) note links stay plain links; a link to a note missing here is a broken link. */
  noteLinks?: Readonly<Record<string, NoteLinkTarget>>
  /** Only the live preview gives it: exported pages, copies and templates show front matter as written. */
  note?: PreviewNote
  /** Changes when plugins' renderers do, so pieces rendered before are rendered again. */
  pluginRenderers?: number
}

export interface PreviewContext extends PreviewOptions {
  frontmatter: string | null
  source: string
}

export interface PreviewRenderer {
  id: string
  apiVersion: typeof PREVIEW_API_VERSION
  /** A renderer that needs a large library loads it here, only when the note uses its feature. */
  transform(tree: Root, context: PreviewContext): void | Promise<void>
}

export interface PreviewRegistry {
  register(renderer: PreviewRenderer): () => void
  ids(): string[]
  renderers(): readonly PreviewRenderer[]
}

export function createRegistry(initial: readonly PreviewRenderer[] = []): PreviewRegistry {
  const list: PreviewRenderer[] = []
  const registry: PreviewRegistry = {
    register(renderer) {
      if (renderer.apiVersion !== PREVIEW_API_VERSION) throw new Error('E_PREVIEW_API_VERSION')
      if (list.some((r) => r.id === renderer.id)) throw new Error('E_PREVIEW_RENDERER_DUPLICATE')
      list.push(renderer)
      return () => {
        const at = list.indexOf(renderer)
        if (at >= 0) list.splice(at, 1)
      }
    },
    ids: () => list.map((r) => r.id),
    renderers: () => list,
  }
  initial.forEach((r) => registry.register(r))
  return registry
}
