// What the find bar drives: the editor (the Markdown source) or the preview
// (the rendered text). Each pane implements this; `useFind` picks one.
import type { FindOptions } from '../../../core/find'

export interface FindStatus {
  total: number
  current: number | null
  invalid: boolean
  capped: boolean
}

export type FindStep = 'next' | 'previous'

export const NO_MATCHES: FindStatus = { total: 0, current: null, invalid: false, capped: false }

/**
 * Why a target calls its listeners: its matches or current match changed,
 * or a key in the pane asks the bar to close or to step through matches.
 */
export type FindChange = 'status' | 'close' | 'next' | 'previous'

export interface FindTarget {
  readonly canReplace: boolean
  /**
   * Marks every match and makes the first one from the selection current;
   * with `step`, the one after (or before) the selection instead.
   */
  search(options: FindOptions, step?: FindStep): void
  next(): void
  previous(): void
  replace(template: string): void
  replaceAll(template: string): void
  clear(): void
  status(): FindStatus
  /** The selected text, when it can be a query (one line, not too long). */
  selectedText(): string
  owns(node: Node | null): boolean
  focus(): void
  subscribe(listener: (change: FindChange) => void): () => void
}

export const MAX_SEED_CHARS = 200

export function seedQuery(text: string): string {
  return text.length > MAX_SEED_CHARS || /[\r\n]/.test(text) ? '' : text
}
