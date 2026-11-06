import { useRef } from 'react'
import type { SidebarProps } from './model'
import type { Drops } from './useDrops'
import type { Folds } from './useFolds'
import type { Menus } from './useMenus'
import type { RowKeys } from './useRowKeys'

/** What the sidebar's parts render from: its props, and the state and handlers of its hooks. */
export interface SidebarView {
  props: SidebarProps
  folds: Folds
  drops: Drops
  menus: Menus
  keys: RowKeys
  elements: RowElements
  selectedBook: string | undefined
  nameEditing: string | undefined
}

/** The sidebar's row elements: every row the arrow keys reach, by row key, and the notebooks' rows, by notebook ID. */
export function useRowElements() {
  const rowElements = useRef(new Map<string, HTMLElement>())
  const rows = useRef(new Map<string, HTMLLIElement>())
  return { rowElements, rows }
}

export type RowElements = ReturnType<typeof useRowElements>
