import { useCallback, useEffect, useRef } from 'react'
import { clipTitle } from '../../../core/noteLimits'
import type { Core } from '../core-client'

/** Each title change re-sorts the lists, so typing is debounced by this much. */
const LIST_TITLE_MS = 150

/** The title field renaming the open note: saved as typed, shown in the lists once typing pauses. */
export function useTitleRename({
  core,
  selected,
  setTitle,
  retitleListed,
}: {
  core: Core | undefined
  selected: string | undefined
  setTitle: (title: string) => void
  retitleListed: (id: string, named: string) => void
}) {
  const typedTitle = useRef<{ id: string; title: string }>(undefined)
  const typedTitleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const listTypedTitle = useCallback(() => {
    clearTimeout(typedTitleTimer.current)
    const typed = typedTitle.current
    typedTitle.current = undefined
    if (typed) retitleListed(typed.id, typed.title)
  }, [retitleListed])
  useEffect(() => () => clearTimeout(typedTitleTimer.current), [])
  const rename = (next: string) => {
    if (!core || !selected) return
    // One line, cut to the longest title storage takes, as the core does:
    // a long paste never stops the note from saving.
    const clean = clipTitle(next)
    setTitle(clean)
    if (typedTitle.current && typedTitle.current.id !== selected) listTypedTitle()
    typedTitle.current = { id: selected, title: clean }
    clearTimeout(typedTitleTimer.current)
    typedTitleTimer.current = setTimeout(listTypedTitle, LIST_TITLE_MS)
    void core.setTitle(selected, clean)
  }
  return rename
}
