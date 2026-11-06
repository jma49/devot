import { useSyncExternalStore } from 'react'
import { sizes } from './theme/tokens'

// A window narrower than size.sidebar-collapse-width has no room for the
// sidebar beside the list and the editor's toolbar, so the sidebar gives way
// until it is asked for (app/usePanes.ts).
const NARROW = `(width < ${sizes['size.sidebar-collapse-width']})`

// WebKit can skip a MediaQueryList's `change` and leave a kept list's `matches`
// stale, while `resize` and a new list stay right.
function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export const useNarrowWindow = () =>
  useSyncExternalStore(subscribe, () => matchMedia(NARROW).matches)
