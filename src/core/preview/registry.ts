// The internal extension point for preview renderers. A renderer transforms
// the sanitized HTML tree (hast) of a note; built-in features use the same
// API. Renderers run after sanitizing, so whatever they add is trusted: they
// must only build structure from validated values, never pass note text
// through as markup.
import type { Root } from 'hast'
import type { NoteStatus, TagColor } from '../storage'
import type { TaskProgress } from '../tasks'

export const PREVIEW_API_VERSION = 1

export interface PreviewLabels {
  alerts: Record<AlertKind, string>
  /** Placeholder text for an embed that loads on click; `{origin}` is the host. */
  embedFrom: string
  embedLoad: string
  videoTitle: string
  /** A note link chip's name for a note without a title. */
  untitled: string
  /** The tooltip of a link to a note that does not exist (or is in the Trash). */
  missingNote: string
  /** A code block's header: `{start}` and `{end}` of its lines, one `{n}`, a `{ref}`. */
  codeLines: string
  codeLine: string
  codeRef: string
  /** The name of the link to a code block's source. */
  codeSource: string
}

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** What a note link chip shows about the note it points at. */
export interface NoteLinkTarget {
  /** The note's title, or the first line of its body; empty when it has neither. */
  title: string
  status: NoteStatus
  tasks: TaskProgress
  /** The note's tags, by name. */
  tags: { name: string; color: TagColor | null }[]
}

export interface PreviewOptions {
  labels: PreviewLabels
  /** Embed URLs from unknown origins the user chose to load. */
  loadedEmbeds: readonly string[]
  /**
   * The live notes the Markdown links to, by ID: those links show as chips,
   * and a link to a note missing here as a broken link. Without it (exported
   * pages) note links stay plain links.
   */
  noteLinks?: Readonly<Record<string, NoteLinkTarget>>
}

export interface PreviewContext extends PreviewOptions {
  /** The note's YAML front matter, without its fences, if it has one. */
  frontmatter: string | null
  /** The note's Markdown, which the tree's source positions point into. */
  source: string
}

export interface PreviewRenderer {
  /** Unique, reverse-DNS style: `devot.alerts`. */
  id: string
  apiVersion: typeof PREVIEW_API_VERSION
  /**
   * Changes the tree in place. A renderer that needs a large library loads it
   * here, only when the note uses its feature, and returns a promise.
   */
  transform(tree: Root, context: PreviewContext): void | Promise<void>
}

export interface PreviewRegistry {
  /** Adds a renderer after the existing ones; returns a function that removes it. */
  register(renderer: PreviewRenderer): () => void
  ids(): string[]
  renderers(): readonly PreviewRenderer[]
}

/** A registry holding `initial`, in order. */
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
