// Plugin blocks that may show other notes (ADR 0028) are drawn again a moment after the notes change, not on each save.
import { useEffect, useState } from 'react'
import { NOTES_LOADED } from '../externalChanges'

export const LIBRARY_REDRAW_MS = 1000

const wrote = new Set<() => void>()

/** This window wrote to the library; changes from elsewhere arrive as NOTES_LOADED. */
export function libraryWrote(): void {
  for (const listener of wrote) listener()
}

/** Counts the settled changes to the library while `watching`; it stays put otherwise. */
export function useLibraryTurn(watching: boolean): number {
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    if (!watching) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const heard = () => {
      timer ??= setTimeout(() => {
        timer = undefined
        setTurn((n) => n + 1)
      }, LIBRARY_REDRAW_MS)
    }
    window.addEventListener(NOTES_LOADED, heard)
    wrote.add(heard)
    return () => {
      window.removeEventListener(NOTES_LOADED, heard)
      wrote.delete(heard)
      clearTimeout(timer)
    }
  }, [watching])
  return turn
}
