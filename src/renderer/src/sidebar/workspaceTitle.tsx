import { MAX_BOOK_NAME_CHARS } from '../../../core/books'
import { trimWhitespace } from '../../../core/text'
import { workspaceShortcut } from '../bookMenu'
import { BookIcon } from '../BookIcon'
import { commandMatches, heldCommandKey } from '../commands/registry'
import { titleWithKey } from '../commands/titles'
import { format as fill, t } from '../i18n'
import { Icon } from '../icons/Icon'
import { below, WORKSPACE_ROW, type SidebarWorkspace } from './model'
import { NameField } from './NameField'
import { keepFocusOnMenu } from './useMenus'
import type { SidebarView } from './view'

/** The notebook open as a workspace, over the rows: its parents to go up to, and its name. */
export const workspaceTitle = (v: SidebarView, space: SidebarWorkspace) => {
  const { props, nameEditing } = v
  const { rowElements } = v.elements
  const { rowProps } = v.keys
  const { rowMenuTarget, setEditing, placed, runAction, openWorkspaceMenu } = v.menus
  const { book } = space
  const editingThis = nameEditing === book.id
  return (
    <div
      className="sidebar-workspace"
      role="group"
      aria-label={fill(t('sidebar.workspaceLabel'), { name: book.name })}
    >
      <button
        type="button"
        className="tool tool-small sidebar-workspace-back"
        aria-label={t('sidebar.workspaceBack')}
        title={titleWithKey('sidebar.workspaceBack', 'sidebar.workspaceUpFromAnyRow')}
        onClick={props.onWorkspaceUp}
      >
        <span className="chevron" data-turn="left">
          <Icon name="disclosure.open" size="sm" />
        </span>
      </button>
      <div
        {...rowProps(WORKSPACE_ROW)}
        className={`sidebar-workspace-title${rowMenuTarget === WORKSPACE_ROW ? ' menu-target' : ''}`}
        onMouseDown={(e) => {
          if (!editingThis) keepFocusOnMenu(e)
        }}
        onDoubleClick={() => props.readOnly || setEditing(book.id)}
        onContextMenu={(e) => {
          // The name field keeps the web view's text menu.
          if (editingThis) return
          e.preventDefault()
          void openWorkspaceMenu()
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (heldCommandKey(e)) return e.preventDefault()
          if (commandMatches('sidebar.rowMenu', e)) {
            e.preventDefault()
            return void openWorkspaceMenu(below(e.currentTarget))
          }
          const action = workspaceShortcut(e)
          if (!action) return
          e.preventDefault()
          runAction(action, placed(book))
        }}
      >
        <BookIcon icon={book.icon} color={book.iconColor} size="md" />
        <span className="sidebar-workspace-names">
          {space.parents.length > 0 ? (
            <span className="sidebar-workspace-path">
              {space.parents.map((parent) => (
                <button
                  key={parent.id}
                  type="button"
                  tabIndex={-1}
                  className="sidebar-workspace-parent"
                  aria-label={fill(t('sidebar.workspaceParent'), {
                    name: parent.name,
                  })}
                  title={fill(t('sidebar.workspaceParent'), {
                    name: parent.name,
                  })}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onOpenWorkspace?.(parent.id)
                  }}
                >
                  {parent.name}
                </button>
              ))}
            </span>
          ) : null}
          {editingThis ? (
            <NameField
              name={book.name}
              max={MAX_BOOK_NAME_CHARS}
              onDone={(name, byKey) => {
                setEditing(undefined)
                props.onRenameDone()
                const clean = name === null ? '' : trimWhitespace(name)
                if (clean && clean !== book.name) props.onRenameBook(book.id, clean)
                if (byKey) rowElements.current.get(WORKSPACE_ROW)?.focus()
              }}
            />
          ) : (
            <span className="sidebar-workspace-name">{book.name}</span>
          )}
        </span>
      </div>
    </div>
  )
}
