import type { Ref } from 'react'
import type { BookNode } from '../../../core/books'
import type { NoteStatus, TagColor, TagColorValue, TagRecord } from '../../../core/storage'
import type { NoteFilter } from '../../../core/tags'
import type { AgentSummary } from '../agentWrites'
import type { BookMenuTarget, ImportAction } from '../bookMenu'
import type { MenuPoint } from '../contextMenu'
import type { ExportFailure } from '../ExportNotice'
import type { IconName } from '../icons/symbols'
import type { MessageKey } from '../i18n'
import { currentLocale } from '../i18n'
import type { SectionStore } from '../sidebarSections'

export type Selection =
  | { kind: 'all' }
  | { kind: 'book'; id: string }
  | { kind: 'templates' }
  | { kind: 'trash' }

/** A saved search row: its live count is null when its query has text, which only a search can count. */
export interface SidebarSavedSearch {
  id: string
  name: string
  count: number | null
}

export function below(row: Element | null | undefined): MenuPoint | undefined {
  if (!row) return undefined
  const box = row.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

/** A notebook open as a workspace: the sidebar shows only it, its notes as All Notes, its sub-notebooks, and the statuses and tags of its notes; no Pinned, Templates or Trash. */
export interface SidebarWorkspace {
  book: BookNode
  parents: readonly BookNode[]
  /** The whole notebook tree (the Move dialog lists every notebook). */
  library: readonly BookNode[]
}

export const WORKSPACE_ROW = 'workspace'

export type PlacedNode = BookNode & BookMenuTarget

export function neighbours(
  tree: BookNode[],
): Map<string, { previousId: string | null; nextId: string | null }> {
  const out = new Map<string, { previousId: string | null; nextId: string | null }>()
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n, i) => {
      out.set(n.id, {
        previousId: nodes[i - 1]?.id ?? null,
        nextId: nodes[i + 1]?.id ?? null,
      })
      walk(n.children)
    })
  walk(tree)
  return out
}

export function subtree(tree: BookNode[], id: string): Set<string> {
  const ids = new Set<string>()
  const add = (n: BookNode) => {
    ids.add(n.id)
    n.children.forEach(add)
  }
  const find = (nodes: BookNode[]): void =>
    nodes.forEach((n) => (n.id === id ? add(n) : find(n.children)))
  find(tree)
  return ids
}

export interface SidebarProps {
  total: number
  tree: BookNode[]
  counts: ReadonlyMap<string, number>
  selection: Selection | null
  renaming: string | undefined
  /** `clearFilter` also turns the filter off (the arrow keys show the row they arrive at as it is). */
  onSelect: (selection: Selection, options?: { clearFilter?: boolean }) => void
  /** Undefined until the core is ready; the button is disabled until then. */
  onCreateBook: ((parentId: string | null) => void) | undefined
  /** Nothing is renamed, moved, dropped or deleted: the trial is over without a licence. */
  readOnly?: boolean
  onRenameBook: (id: string, name: string) => void
  onRenameDone: () => void
  onMoveBook: (id: string, parentId: string | null) => void
  onPlaceBook: (id: string, targetId: string, where: 'before' | 'after') => void
  onSetAiAccess: (id: string, on: boolean) => void
  onSetBookIcon: (id: string, icon: string | null, color: TagColor | null) => void
  onDeleteBook: (id: string) => void
  onExportBook: (action: 'exportMarkdown' | 'exportHtml', id: string) => void
  onImportBook: (action: ImportAction, id: string) => void
  onMoveNotes: (noteIds: string[], bookId: string) => void
  onTagNotes?: (noteIds: string[], tagId: string) => void
  onSetNotesStatus?: (noteIds: string[], status: NoteStatus) => void
  onTrashNotes?: (noteIds: string[]) => void
  filter: NoteFilter | null
  onFilter: (filter: NoteFilter | null) => void
  pinnedCount: number
  statusCounts: ReadonlyMap<NoteStatus, number>
  /** The Agents section (ADR 0007): the writers of this device's recent agent writes, newest first. */
  agents?: readonly AgentSummary[]
  tags: readonly TagRecord[]
  tagCounts: ReadonlyMap<string, number>
  onRenameTag: (id: string, name: string) => void
  onSetTagColor: (id: string, color: TagColorValue | null) => void
  onDeleteTag: (id: string) => void
  templatesCount: number
  trashCount: number
  onSearchBooks: () => void
  /** Filled with the notebook and tag menus, for the note list header's name to open. */
  menus?: Ref<SidebarMenus> | undefined
  onSearchTags: () => void
  onEmptyTrash: () => void
  /** Shows a copy that failed, with its code, as the note copy actions do. */
  onCopyFailed?: (failure: ExportFailure, code: string) => void
  /** Makes a new note (the All Notes row's menu); absent while the library is not open. */
  onNewNote?: (() => void) | undefined
  /** Where the collapsed sections are kept; this window's local storage by default. */
  sectionStore?: SectionStore
  workspace?: SidebarWorkspace | undefined
  onOpenWorkspace?: (id: string) => void
  onWorkspaceUp?: () => void
  savedSearches?: readonly SidebarSavedSearch[]
  /** The saved search the search field runs now. */
  activeSearch?: string | undefined
  onRunSavedSearch?: (id: string) => void
  onRenameSavedSearch?: (id: string, name: string) => void
  onEditSavedSearch?: (id: string) => void
  onDeleteSavedSearch?: (id: string) => void
  onPlaceSavedSearch?: (id: string, targetId: string, where: 'before' | 'after') => void
}

export interface SidebarMenus {
  book: (id: string, at: MenuPoint) => void
  tag: (id: string, at: MenuPoint) => void
}

export const STATUSES: { status: NoteStatus; icon: IconName; label: MessageKey }[] = [
  { status: 'active', icon: 'status.active', label: 'status.active' },
  { status: 'on_hold', icon: 'status.onHold', label: 'status.on_hold' },
  { status: 'completed', icon: 'status.completed', label: 'status.completed' },
  { status: 'dropped', icon: 'status.dropped', label: 'status.dropped' },
]

export const sameFilter = (a: NoteFilter | null, b: NoteFilter) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind !== 'status' || (b.kind === 'status' && a.status === b.status)) &&
  (a.kind !== 'tag' || (b.kind === 'tag' && a.tagId === b.tagId)) &&
  (a.kind !== 'agent' || (b.kind === 'agent' && a.writer === b.writer))

export const format = (n: number) => new Intl.NumberFormat(currentLocale()).format(n)

export function visibleRows(tree: BookNode[], collapsed: ReadonlySet<string>): BookNode[] {
  const out: BookNode[] = []
  const walk = (nodes: BookNode[]) =>
    nodes.forEach((n) => {
      out.push(n)
      if (!collapsed.has(n.id)) walk(n.children)
    })
  walk(tree)
  return out
}

/** A row the arrow keys move between; its key is `all`, `pinned`, `book:<id>`, `status:<status>`, `search:<id>`, `tag:<id>`, `agent:<writer>`, `templates` or `trash`. */
export interface Row {
  key: string
  shows: { selection: Selection } | { filter: NoteFilter } | { search: string }
}

export const searchRow = (id: string): Row => ({ key: `search:${id}`, shows: { search: id } })

export const libraryRow = (selection: Selection): Row => ({
  key: selection.kind === 'book' ? `book:${selection.id}` : selection.kind,
  shows: { selection },
})

export const filterRowOf = (filter: NoteFilter): Row => ({
  key:
    filter.kind === 'pinned'
      ? 'pinned'
      : filter.kind === 'status'
        ? `status:${filter.status}`
        : filter.kind === 'agent'
          ? `agent:${filter.writer}`
          : `tag:${filter.tagId}`,
  shows: { filter },
})

export const agentFilter = (agent: AgentSummary): NoteFilter => ({
  kind: 'agent',
  writer: agent.key,
  noteIds: agent.noteIds,
})
