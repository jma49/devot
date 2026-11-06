import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { BookNode } from '../../../core/books'
import { DRAG_BOOK, DRAG_NOTE, DRAG_SEARCH, DRAG_TEMPLATE } from '../dragData'
import { subtree, type SidebarProps } from './model'

const draggedNotes = (event: DragEvent) =>
  event.dataTransfer.getData(DRAG_NOTE).split('\n').filter(Boolean)

/**
 * Where a dragged notebook goes on a notebook row: the top quarter puts it
 * before that notebook, the bottom quarter after it, the middle inside it.
 * Notes always go inside.
 */
type DropZone = 'before' | 'inside' | 'after'

interface DropAt {
  id: string | null
  zone: DropZone
  /** Notes are over the row (not a notebook): it fills rather than outlines. */
  notes: boolean
}

function zoneAt(event: DragEvent): DropZone {
  const box = event.currentTarget.getBoundingClientRect()
  const y = event.clientY - box.top
  if (y < box.height / 4) return 'before'
  if (y > (box.height * 3) / 4) return 'after'
  return 'inside'
}

/** Where a notebook, notes or a saved search dragged over the sidebar would go, and what dropping them does. */
export function useDrops(props: SidebarProps, collapsed: ReadonlySet<string>) {
  const { tree } = props
  const ws = props.workspace
  const [dropAt, setDropAt] = useState<DropAt>()
  // The notebook being dragged from this sidebar with its sub-notebooks: where it cannot go.
  const dragging = useRef<ReadonlySet<string> | undefined>(undefined)
  const [draggedBook, setDraggedBook] = useState<string>()
  const [searchDrop, setSearchDrop] = useState<{ id: string; where: 'before' | 'after' }>()
  const [noteDrop, setNoteDrop] = useState<string>()

  const noteTarget = (
    key: string,
    take: ((ids: string[]) => void) | undefined,
    templates: boolean,
  ) => {
    if (!take) return { className: '' }
    const accepts = (event: DragEvent) => {
      const { types } = event.dataTransfer
      return types.includes(DRAG_NOTE) && (templates || !types.includes(DRAG_TEMPLATE))
    }
    const over = (event: DragEvent) => {
      if (!accepts(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setNoteDrop(key)
    }
    return {
      className: noteDrop === key ? ' drop-fill' : '',
      handlers: {
        onDragEnter: over,
        onDragOver: over,
        onDragLeave: (event: DragEvent) => {
          const box = event.currentTarget.getBoundingClientRect()
          const { clientX: x, clientY: y } = event
          if (x > box.left && x < box.right && y > box.top && y < box.bottom) return
          setNoteDrop((at) => (at === key ? undefined : at))
        },
        onDrop: (event: DragEvent) => {
          if (!accepts(event)) return
          event.preventDefault()
          setNoteDrop(undefined)
          const ids = draggedNotes(event)
          if (ids.length > 0) take(ids)
        },
      },
    }
  }

  const openParent = (node: BookNode) => node.children.length > 0 && !collapsed.has(node.id)

  const searchDropAt = (event: DragEvent, id: string) => {
    if (!event.dataTransfer.types.includes(DRAG_SEARCH)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const box = event.currentTarget.getBoundingClientRect()
    const where = event.clientY - box.top < box.height / 2 ? 'before' : 'after'
    setSearchDrop((at) => (at?.id === id && at.where === where ? at : { id, where }))
  }
  const canPlaceSearch = !props.readOnly && props.onPlaceSavedSearch !== undefined

  const onDragOver = (event: DragEvent, node: BookNode | null) => {
    const types = event.dataTransfer.types
    const isBook = types.includes(DRAG_BOOK)
    if (!isBook && !(node && types.includes(DRAG_NOTE))) return
    // A notebook never goes on itself or among its own sub-notebooks.
    if (isBook && node && dragging.current?.has(node.id)) {
      setDropAt(undefined)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const next: DropAt = {
      id: node?.id ?? null,
      zone: isBook && node ? zoneAt(event) : 'inside',
      notes: !isBook,
    }
    setDropAt((at) =>
      at?.id === next.id && at.zone === next.zone && at.notes === next.notes ? at : next,
    )
  }

  const onDrop = (event: DragEvent, node: BookNode | null) => {
    event.preventDefault()
    setDropAt(undefined)
    const book = event.dataTransfer.getData(DRAG_BOOK)
    const note = event.dataTransfer.getData(DRAG_NOTE)
    if (book && node === null) {
      const first = tree[0]
      if (first && first.id !== book) props.onPlaceBook(book, first.id, 'before')
      else if (!first && ws && ws.book.id !== book) props.onMoveBook(book, ws.book.id)
    } else if (book && node) {
      if (subtree(tree, book).has(node.id)) return
      const zone = zoneAt(event)
      if (zone === 'inside') props.onMoveBook(book, node.id)
      else props.onPlaceBook(book, node.id, zone)
    } else if (note && node) props.onMoveNotes(draggedNotes(event), node.id)
  }

  /**
   * Leaving a row for one of its own children fires dragleave too; only a
   * pointer outside the row ends the drop there.
   */
  const onDragLeave = (event: DragEvent, id: string | null) => {
    const box = event.currentTarget.getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    if (x > box.left && x < box.right && y > box.top && y < box.bottom) return
    // The row entered next may have set its own drop already.
    setDropAt((at) => (at?.id === id ? undefined : at))
  }

  // A drag that ends anywhere (dropped, or cancelled over a row, where dragleave keeps the drop) ends the drop.
  useEffect(() => {
    const clear = () => {
      setDropAt(undefined)
      setNoteDrop(undefined)
      setDraggedBook(undefined)
    }
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
    }
  }, [])

  /** After an open notebook the line goes on its item, under its sub-notebooks, where the notebook will go. */
  const dropClasses = (node: BookNode, part: 'item' | 'row') => {
    if (dropAt?.id !== node.id) return ''
    const onItem = dropAt.zone === 'after' && openParent(node)
    if ((part === 'item') !== onItem) return ''
    if (dropAt.zone === 'inside') return dropAt.notes ? ' drop-fill' : ' drop-target'
    if (dropAt.zone === 'before') return ' drop-before'
    return ' drop-after'
  }

  return {
    dropAt,
    setDropAt,
    dragging,
    draggedBook,
    setDraggedBook,
    searchDrop,
    setSearchDrop,
    noteTarget,
    searchDropAt,
    canPlaceSearch,
    onDragOver,
    onDrop,
    onDragLeave,
    dropClasses,
  }
}

export type Drops = ReturnType<typeof useDrops>
