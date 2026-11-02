import { useEffect, useState } from 'react'

// Less than this is a hardware keyboard's shortcut bar, not the on-screen keyboard.
const KEYBOARD_MIN = 80

/** How much of the layout viewport the on-screen keyboard covers, in points. */
export const keyboardCover = (
  layoutHeight: number,
  visualHeight: number,
  visualTop: number,
): number => Math.max(0, Math.round(layoutHeight - visualHeight - visualTop))

export const keyboardOpen = (cover: number): boolean => cover >= KEYBOARD_MIN

/** The on-screen keyboard, followed through `visualViewport`. */
export function useKeyboard(): { open: boolean; height: number } {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const update = () =>
      setHeight(keyboardCover(window.innerHeight, viewport.height, viewport.offsetTop))
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return { open: keyboardOpen(height), height }
}
