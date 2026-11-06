import { Fragment, type CSSProperties } from 'react'
import { MAX_BOOK_NAME_CHARS, type BookNode } from '../../../core/books'
import { trimWhitespace } from '../../../core/text'
import { BookIcon } from '../BookIcon'
import { Chevron } from '../Chevron'
import { setBookDragData } from '../dragData'
import { t } from '../i18n'
import { Icon } from '../icons/Icon'
import { setDragCard } from '../listDrag'
import { format, libraryRow, subtree } from './model'
import { NameField } from './NameField'
import type { SidebarView } from './view'

/** A notebook's row in the tree, and its open sub-notebooks after it. */
export const bookNode = (v: SidebarView, node: BookNode) => {
  const { props, selectedBook, nameEditing } = v
  const { rows } = v.elements
  const { tree, counts } = props
  const { collapsed, toggle, revealed } = v.folds
  const {
    dragging,
    draggedBook,
    setDraggedBook,
    setDropAt,
    dropClasses,
    onDragOver,
    onDragLeave,
    onDrop,
  } = v.drops
  const { menuTarget, setEditing, openMenu } = v.menus
  const { rowProps, onKey } = v.keys
  const focusBook = (id: string) => {
    props.onSelect({ kind: 'book', id })
    rows.current.get(id)?.focus()
  }
  const isOpen = !collapsed.has(node.id)
  const isSelected = node.id === selectedBook
  const editingThis = nameEditing === node.id
  const row = rowProps(libraryRow({ kind: 'book', id: node.id }).key)
  const groupId = `book-children-${node.id}`
  const showChildren = node.children.length > 0 && isOpen
  // The treeitem holds only its own row, so an assistive technology that
  // presses or opens the menu at its centre reaches this notebook, not a
  // sub-notebook. Its sub-notebooks sit beside it and are owned by it.
  return (
    <Fragment key={node.id}>
      <li
        style={{ '--book-depth': node.depth } as CSSProperties}
        data-sidebar-row={row['data-sidebar-row']}
        data-motion-key={`book:${node.id}`}
        ref={(el) => {
          row.ref(el)
          if (el) rows.current.set(node.id, el)
          else rows.current.delete(node.id)
        }}
        role="treeitem"
        aria-level={node.depth + 1}
        aria-selected={isSelected}
        aria-expanded={node.children.length > 0 ? isOpen : undefined}
        aria-owns={showChildren ? groupId : undefined}
        tabIndex={row.tabIndex}
        draggable={!editingThis && !props.readOnly}
        onDragStart={(e) => {
          e.stopPropagation()
          setBookDragData(e.dataTransfer, node)
          dragging.current = subtree(tree, node.id)
          setDraggedBook(node.id)
          setDragCard(e.dataTransfer, [node.name])
        }}
        onDragEnd={(e) => {
          e.stopPropagation()
          dragging.current = undefined
          setDropAt(undefined)
          setDraggedBook(undefined)
        }}
        onKeyDown={(e) => onKey(e, node)}
        onClick={(e) => {
          e.stopPropagation()
          focusBook(node.id)
        }}
      >
        <div
          className={`book-row${dropClasses(node, 'row')}${menuTarget === node.id ? ' menu-target' : ''}`}
          data-dragging={draggedBook === node.id || undefined}
          onDoubleClick={() => props.readOnly || setEditing(node.id)}
          onMouseDown={(e) => {
            // A right-click (or Control-click) leaves the keyboard where it
            // was: the keys keep acting on the selected notebook.
            if (!editingThis && (e.button === 2 || e.ctrlKey)) e.preventDefault()
          }}
          onContextMenu={(e) => {
            // The name field keeps the web view's text menu.
            if (editingThis) return
            e.preventDefault()
            void openMenu(node)
          }}
          onDragEnter={(e) => onDragOver(e, node)}
          onDragOver={(e) => onDragOver(e, node)}
          onDragLeave={(e) => onDragLeave(e, node.id)}
          onDrop={(e) => {
            e.stopPropagation()
            onDrop(e, node)
          }}
        >
          <span
            className="disclosure"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation()
              if (node.children.length > 0) toggle(node.id)
            }}
          >
            {node.children.length > 0 ? <Chevron open={isOpen} closed="right" /> : null}
          </span>
          <BookIcon icon={node.icon} color={node.iconColor} size="md" />
          {editingThis ? (
            <NameField
              name={node.name}
              max={MAX_BOOK_NAME_CHARS}
              onDone={(name, byKey) => {
                setEditing(undefined)
                props.onRenameDone()
                const clean = name === null ? '' : trimWhitespace(name)
                if (clean && clean !== node.name) {
                  props.onRenameBook(node.id, clean)
                }
                // The keyboard goes back to the selected notebook, which is
                // this one unless it was renamed from its menu; this one when
                // the selected notebook is hidden in a collapsed parent.
                if (byKey) {
                  const back = selectedBook ? rows.current.get(selectedBook) : undefined
                  ;(back ?? rows.current.get(node.id))?.focus()
                }
              }}
            />
          ) : (
            <span className="source-label" dir="auto">
              {node.name}
            </span>
          )}
          {node.aiAccess ? (
            <span
              className="book-ai"
              role="img"
              aria-label={t('book.aiAccessOn')}
              title={t('book.aiAccessOn')}
            >
              <Icon name="notebook.ai" size="sm" />
            </span>
          ) : null}
          <span className="source-count">{format(counts.get(node.id) ?? 0)}</span>
        </div>
      </li>
      {showChildren ? (
        <li
          role="none"
          className={dropClasses(node, 'item').trim() || undefined}
          style={{ '--book-depth': node.depth } as CSSProperties}
        >
          <ul id={groupId} role="group" ref={revealed(`book:${node.id}`)}>
            {node.children.map((child) => bookNode(v, child))}
          </ul>
        </li>
      ) : null}
    </Fragment>
  )
}
