import { useState } from 'react'

/** The note whose quick tag popover is open; opening another note closes it for good. */
export function useQuickTagNote(selected: string | undefined) {
  const [quickTagNote, setQuickTagNote] = useState<string>()
  if (quickTagNote !== undefined && quickTagNote !== selected) setQuickTagNote(undefined)
  return [quickTagNote, setQuickTagNote] as const
}
