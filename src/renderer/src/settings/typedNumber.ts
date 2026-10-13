// A number field that stores what is typed once typing pauses, and only when
// it is a whole number in range. The field shows what is typed while it has
// the focus; otherwise it shows the stored value (also after a change made
// elsewhere, or a refused one).
import { useEffect, useRef, useState } from 'react'

/** How long typing in a number field pauses before the value is stored. */
export const TYPING_PAUSE_MS = 400

export function useTypedNumber({
  stored,
  min,
  max,
  store,
}: {
  stored: number
  min: number
  max: number
  store: (value: number) => void
}) {
  const [typed, setTyped] = useState<string | null>(null)
  // A typed value waiting for a pause in typing, so each keystroke (or each
  // step of a held arrow key) is not stored and sent to every window.
  const waiting = useRef<{ timer: ReturnType<typeof setTimeout>; value: number } | null>(null)
  useEffect(() => () => clearTimeout(waiting.current?.timer), [])

  const flush = () => {
    const pending = waiting.current
    if (!pending) return
    clearTimeout(pending.timer)
    waiting.current = null
    store(pending.value)
  }

  return {
    value: typed ?? String(stored),
    type(text: string) {
      setTyped(text)
      if (waiting.current) clearTimeout(waiting.current.timer)
      waiting.current = null
      const value = Number(text)
      if (
        text.trim() !== '' &&
        Number.isInteger(value) &&
        value >= min &&
        value <= max &&
        value !== stored
      )
        waiting.current = { timer: setTimeout(flush, TYPING_PAUSE_MS), value }
    },
    leave() {
      flush()
      setTyped(null)
    },
  }
}
