import { useSyncExternalStore } from 'react'
import { sizes } from './theme/tokens'

// A window narrower than size.sidebar-collapse-width has no room for the
// sidebar beside the list and the editor's toolbar, so the sidebar gives way
// until it is asked for (App.tsx).
const NARROW = `(width < ${sizes['size.sidebar-collapse-width']})`

function subscribe(onChange: () => void) {
  const query = matchMedia(NARROW)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useNarrowWindow = () =>
  useSyncExternalStore(subscribe, () => matchMedia(NARROW).matches)
