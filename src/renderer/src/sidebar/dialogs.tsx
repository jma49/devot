import { flattenBookTree } from '../../../core/books'
import { MoveBookDialog } from '../MoveBookDialog'
import { NotebookIconDialog } from '../NotebookIconDialog'
import { TagMenu } from '../TagMenuPanel'
import { TagSettingsDialog } from '../TagSettingsDialog'
import type { SidebarView } from './view'

/** The dialogs and the tag menu the sidebar's menus open. */
export function sidebarDialogs(v: SidebarView) {
  const { props } = v
  const { tree } = props
  const ws = props.workspace
  const {
    movingBook,
    setMovingBook,
    iconBookId,
    setIconBookId,
    tagSettings,
    setTagSettings,
    tagMenu,
    setTagMenu,
    shownTagMenu,
    tagTarget,
    runTagAction,
  } = v.menus
  const settingsTag = props.tags.find((tag) => tag.id === tagSettings)
  // Closed when the notebook goes (deleted on another device).
  const iconBook =
    iconBookId === undefined
      ? undefined
      : flattenBookTree(ws?.library ?? tree).find((n) => n.id === iconBookId)
  return (
    <>
      {movingBook ? (
        <MoveBookDialog
          tree={ws?.library ?? tree}
          book={movingBook}
          onMove={(parentId) => {
            props.onMoveBook(movingBook.id, parentId)
            setMovingBook(undefined)
          }}
          onCancel={() => setMovingBook(undefined)}
        />
      ) : null}
      {iconBook ? (
        <NotebookIconDialog
          book={iconBook}
          onPick={(icon, color) => {
            if (icon !== iconBook.icon || color !== iconBook.iconColor)
              props.onSetBookIcon(iconBook.id, icon, color)
            setIconBookId(undefined)
          }}
          onRevert={() => {
            props.onSetBookIcon(iconBook.id, null, null)
            setIconBookId(undefined)
          }}
          onCancel={() => setIconBookId(undefined)}
        />
      ) : null}
      {shownTagMenu && tagMenu ? (
        <TagMenu
          tag={{ ...tagTarget(shownTagMenu), name: shownTagMenu.name }}
          at={tagMenu.at}
          onAction={(action) => runTagAction(action, tagTarget(shownTagMenu))}
          onColor={(color) => {
            if (!props.readOnly) props.onSetTagColor(shownTagMenu.id, color)
          }}
          onClose={() => setTagMenu(undefined)}
        />
      ) : null}
      {settingsTag ? (
        <TagSettingsDialog
          tag={settingsTag}
          onSave={({ name, color }) => {
            if (name !== settingsTag.name) props.onRenameTag(settingsTag.id, name)
            if (color !== settingsTag.color) props.onSetTagColor(settingsTag.id, color)
            setTagSettings(undefined)
          }}
          onCancel={() => setTagSettings(undefined)}
        />
      ) : null}
    </>
  )
}
