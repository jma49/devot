import type { NoteSummary } from '../../../core'
import type { CommandHandlers } from '../commands/registry'
import type { EditorHandle } from '../editor/handle'
import { t } from '../i18n'
import { actionOfEntry, type PluginAction } from '../plugins/contributions'
import type { Selection } from '../Sidebar'
import type { NoteFilter } from '../../../core/tags'
import type { PaletteActions } from './CommandPalette'
import { withTagClause } from './entries'
import type { PaletteEntry } from './results'

type Run = void | Promise<unknown>

/** What the main window shows and does, as far as the palette's entries need it. */
export interface PaletteContext {
  commands: CommandHandlers
  editing: boolean
  /** The note open alone, outside the Trash. */
  openNote: NoteSummary | undefined
  selectedIsTemplate: boolean
  selected: string | undefined
  inTrash: boolean
  query: string
  runPlugin: (action: PluginAction) => Run
  showLibrary: (next: Selection) => Run
  openWorkspace: (id: string) => Run
  moveNote: (noteId: string, bookId: string) => Run
  showFilter: (next: NoteFilter) => Run
  changeQuery: (next: string) => Run
  putTagOnNotes: (ids: readonly string[], tagId: string) => Run
  editor: () => EditorHandle | null
  select: (id: string) => Run
}

/** What picking a palette entry does, alone and with Shift or Command held. */
export function paletteActions(entry: PaletteEntry, at: PaletteContext): PaletteActions {
  const { openNote } = at
  switch (entry.kind) {
    case 'source':
      return {
        primary: { label: t('palette.openSource'), run: () => undefined },
      }
    case 'command': {
      const pluginAction = actionOfEntry(entry.id)
      if (pluginAction) {
        return { primary: { label: t('palette.run'), run: () => at.runPlugin(pluginAction) } }
      }
      const handler = at.commands[entry.id as keyof CommandHandlers]
      return {
        primary: { label: t('palette.run'), run: () => handler?.run() },
      }
    }
    case 'book':
      return {
        primary: {
          label: t('palette.openNotebook'),
          run: () => at.showLibrary({ kind: 'book', id: entry.id }),
        },
        meta: {
          label: t('palette.openWorkspace'),
          run: () => at.openWorkspace(entry.id),
        },
        shift:
          at.editing && openNote && openNote.bookId !== entry.id
            ? {
                label: t('palette.moveNoteHere'),
                run: () => at.moveNote(openNote.id, entry.id),
              }
            : undefined,
      }
    case 'tag':
      return {
        primary: {
          label: t('palette.showTag'),
          run: () => at.showFilter({ kind: 'tag', tagId: entry.id }),
        },
        meta: {
          label: t('palette.addToFilter'),
          run: () => at.changeQuery(withTagClause(at.query, { id: entry.id, name: entry.label })),
        },
        shift:
          at.editing && openNote && !at.selectedIsTemplate && !openNote.tagIds.includes(entry.id)
            ? {
                label: t('palette.addTagToNote'),
                run: () => at.putTagOnNotes([openNote.id], entry.id),
              }
            : undefined,
      }
    case 'line':
      return {
        primary: {
          label: t('palette.goToLine'),
          run: () => at.editor()?.goToLine(entry.line ?? 1, 'center'),
        },
      }
    case 'outline':
      return {
        primary: {
          label: t('palette.goToLine'),
          run: () => at.editor()?.goToLine(entry.line ?? 1),
        },
      }
    case 'note':
      return {
        primary: {
          label: t('palette.open'),
          run: () => {
            // Notes listed are live: leave the Trash to show one. The open
            // note stays as it is.
            if (at.inTrash) at.showLibrary({ kind: 'all' })
            else if (entry.id === at.selected) return
            return at.select(entry.id)
          },
        },
      }
  }
}
