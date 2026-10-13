// What the find bar drives: the editor (the Markdown source) or the preview
// (the rendered text). Each pane implements this; `useFind` picks one.
import type { FindOptions } from '../../../core/find'

export interface FindStatus {
  /** Matches found (at most MAX_FIND_MATCHES). */
  total: number
  /** The current match's index, or null when no match is current. */
  current: number | null
  /** The query is not a valid regular expression. */
  invalid: boolean
  /** More matches exist than were counted. */
  capped: boolean
}

/** A step through the matches. */
export type FindStep = 'next' | 'previous'

export const NO_MATCHES: FindStatus = { total: 0, current: null, invalid: false, capped: false }

/**
 * Why a target calls its listeners: its matches or current match changed,
 * or a key in the pane asks the bar to close or to step through matches.
 */
export type FindChange = 'status' | 'close' | 'next' | 'previous'

export interface FindTarget {
  /** The editor can replace; the preview cannot. */
  readonly canReplace: boolean
  /**
   * Marks every match and makes the first one from the selection current;
   * with `step`, the one after (or before) the selection instead.
   */
  search(options: FindOptions, step?: FindStep): void
  next(): void
  previous(): void
  /** Replaces the current match (or moves to the next one) and goes on. */
  replace(template: string): void
  /** Replaces every match as one edit. */
  replaceAll(template: string): void
  /** Removes the marks. */
  clear(): void
  status(): FindStatus
  /** The selected text, when it can be a query (one line, not too long). */
  selectedText(): string
  /** Whether a DOM node belongs to this pane (it has the focus). */
  owns(node: Node | null): boolean
  focus(): void
  /** Called after matches or the current match change, or for a key in the pane. */
  subscribe(listener: (change: FindChange) => void): () => void
}

/** The longest selection that seeds a query. */
export const MAX_SEED_CHARS = 200

/** `text` when it can seed a query, else ''. */
export function seedQuery(text: string): string {
  return text.length > MAX_SEED_CHARS || /[\r\n]/.test(text) ? '' : text
}
