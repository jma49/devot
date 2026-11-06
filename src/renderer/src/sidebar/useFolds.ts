import { useRef, useState } from 'react'
import { conceal, reveal } from '../reveal'
import type { CollapsibleSection, SectionStore } from '../sidebarSections'

/** The folded sections and collapsed notebooks, kept in `sections`, and their fold animations. */
export function useFolds(sections: SectionStore) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => sections.loadBooks())
  const [folded, setFolded] = useState<ReadonlySet<CollapsibleSection>>(() => sections.load())
  // The latest sets: a fold waits for its animation, so two quick folds must each
  // build on the other's result, not on the sets of the render that began them.
  const collapsedNow = useRef(collapsed)
  const foldedNow = useRef(folded)
  const revealNext = useRef(new Set<string>())
  const lists = useRef(new Map<string, HTMLElement>())
  const closing = useRef(new Set<string>())
  const revealed = (key: string) => (el: HTMLElement | null) => {
    if (!el) return void lists.current.delete(key)
    lists.current.set(key, el)
    if (revealNext.current.delete(key)) reveal(el)
  }
  const animated = (key: string, opening: boolean, change: () => void) => {
    if (closing.current.has(key)) {
      if (!opening) return
      // Still open underneath: the close turns back from where it is.
      closing.current.delete(key)
      const el = lists.current.get(key)
      if (el) reveal(el)
      return
    }
    if (opening) return change()
    closing.current.add(key)
    conceal(lists.current.get(key), () => {
      closing.current.delete(key)
      change()
    })
  }
  const toggleSection = (section: CollapsibleSection, open?: boolean) => {
    const key = `section:${section}`
    const opening = open ?? (folded.has(section) || closing.current.has(key))
    animated(key, opening, () => {
      const next = new Set(foldedNow.current)
      if (opening) {
        revealNext.current.add(`section:${section}`)
        next.delete(section)
      } else next.add(section)
      foldedNow.current = next
      setFolded(next)
      sections.save(next)
    })
  }
  const sectionToggles = useRef(new Map<CollapsibleSection, HTMLButtonElement>())

  const toggle = (id: string, open?: boolean) => {
    const key = `book:${id}`
    const shown = !collapsed.has(id) && !closing.current.has(key)
    const opening = open ?? !shown
    if (opening === shown) return
    animated(key, opening, () => {
      if (opening) revealNext.current.add(`book:${id}`)
      const next = new Set(collapsedNow.current)
      if (opening) next.delete(id)
      else next.add(id)
      collapsedNow.current = next
      setCollapsed(next)
      sections.saveBooks(next)
    })
  }

  return { collapsed, folded, revealed, toggleSection, toggle, sectionToggles }
}

export type Folds = ReturnType<typeof useFolds>
