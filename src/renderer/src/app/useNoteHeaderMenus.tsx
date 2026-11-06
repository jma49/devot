import { useState } from 'react'
import type { TagColorValue, TagRecord } from '../../../core'
import type { NoteFilter } from '../../../core/tags'
import { errorCode } from '../backups'
import { useContextMenu } from '../contextMenu'
import type { Core } from '../core-client'
import type { ExportFailure } from '../ExportNotice'
import {
  CHIP_MENU,
  NOTEBOOK_MENU,
  type ChipAction,
  type ChipMenuTarget,
  type NotebookAction,
  type NotebookMenuTarget,
} from '../headerMenus'
import { copyText } from '../noteMenu'
import type { Selection } from '../Sidebar'
import { useStable } from '../stable'
import { TagSettingsDialog } from '../TagSettingsDialog'

/** The menus of the open note's tag chips and notebook picker, and the tag settings they open. */
export function useNoteHeaderMenus({
  tags,
  selected,
  changeBooks,
  setExportNotice,
  sidebarFilter,
  sidebarSelect,
  sidebarRenameTag,
  sidebarSetTagColor,
}: {
  tags: TagRecord[]
  selected: string | undefined
  changeBooks: (change: (c: Core) => Promise<unknown>) => Promise<void>
  setExportNotice: (notice: { failure: ExportFailure; code: string }) => void
  sidebarFilter: (next: NoteFilter | null) => void
  sidebarSelect: (next: Selection, options?: { clearFilter?: boolean }) => void
  sidebarRenameTag: (id: string, name: string) => void
  sidebarSetTagColor: (id: string, color: TagColorValue | null) => void
}) {
  const [headerTagSettings, setHeaderTagSettings] = useState<string>()
  const removeOpenTag = useStable(
    (tagId: string) =>
      void (selected !== undefined && changeBooks((c) => c.removeTag(selected, tagId))),
  )
  const runChipAction = useStable((action: ChipAction, chip: ChipMenuTarget) => {
    switch (action) {
      case 'settings':
        return setHeaderTagSettings(chip.tagId)
      case 'remove':
        return removeOpenTag(chip.tagId)
      case 'filter':
        return sidebarFilter(chip.filtered ? null : { kind: 'tag', tagId: chip.tagId })
      case 'copyId':
        return void copyText(chip.tagId).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_TAG_COPY_FAILED', chip.tagId, code)
          setExportNotice({ failure: 'copyId', code })
        })
    }
  })
  const showChipMenu = useContextMenu('noteTag', CHIP_MENU, runChipAction)
  const runNotebookAction = useStable((action: NotebookAction, book: NotebookMenuTarget) => {
    switch (action) {
      case 'open':
        return sidebarSelect({ kind: 'book', id: book.bookId })
      case 'copyId':
        return void copyText(book.bookId).catch((e: unknown) => {
          const code = errorCode(e)
          console.warn('W_BOOK_COPY_FAILED', book.bookId, code)
          setExportNotice({ failure: 'copyId', code })
        })
    }
  })
  const showNotebookMenu = useContextMenu('noteBook', NOTEBOOK_MENU, runNotebookAction)
  const headerTag = tags.find((tag) => tag.id === headerTagSettings)
  const dialog = headerTag ? (
    <TagSettingsDialog
      tag={headerTag}
      onSave={({ name, color }) => {
        if (name !== headerTag.name) sidebarRenameTag(headerTag.id, name)
        if (color !== headerTag.color) sidebarSetTagColor(headerTag.id, color)
        setHeaderTagSettings(undefined)
      }}
      onCancel={() => setHeaderTagSettings(undefined)}
    />
  ) : null
  return { showChipMenu, showNotebookMenu, dialog }
}
